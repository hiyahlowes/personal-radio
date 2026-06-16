#!/usr/bin/env node
/**
 * Via Moderator Service
 *
 * Local HTTP service on :8902 that wraps Hermes/Via for radio moderation.
 * Keeps ONE persistent Hermes session so Via accumulates context across
 * calls (previous songs, podcasts, prior descriptions).
 *
 * DESIGN PRINCIPLE: Via does NOT speak as the moderator.
 * Via is the advisor/scriptwriter who prepares text for the moderator.
 * The moderator (Claude Haiku + ElevenLabs in the frontend) has its own
 * personality and speaks the text in its own voice.
 *
 * Routes:
 *   GET  /health      → { ok: true, session: sessionId|null }
 *   POST /moderation  → same request body as /.netlify/functions/claude-proxy
 *                       returns Anthropic-format JSON
 *
 * Environment variables:
 *   VIA_MODERATOR_PORT       default 8902
 *   HERMES_BIN               default ~/.local/bin/hermes
 *   VIA_HERMES_TIMEOUT_MS    default 120000
 *   VIA_STATE_DIR            default ~/.local/state/personal-radio
 */

import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.VIA_MODERATOR_PORT || 8902);
const HERMES_BIN = process.env.HERMES_BIN || path.join(homedir(), '.local', 'bin', 'hermes');
const STATE_DIR = process.env.VIA_STATE_DIR || path.join(homedir(), '.local', 'state', 'personal-radio');
const SESSION_FILE = path.join(STATE_DIR, 'via-session.json');
const TIMEOUT_MS = Number(process.env.VIA_HERMES_TIMEOUT_MS || 120000);

// --- Session persistence ---

function loadSession() {
  try {
    const saved = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    return saved.sessionId || null;
  } catch {
    return null;
  }
}

function saveSession(id) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: id }, null, 2));
  } catch (e) {
    console.warn('[via-moderator] could not persist session:', e.message);
  }
}

// --- Prompt building ---

/**
 * Extract the last user-role text from an Anthropic-style messages array.
 */
export function extractTask(messages) {
  if (!Array.isArray(messages)) return '';
  const userMsgs = messages.filter(m => m.role === 'user');
  if (!userMsgs.length) return '';
  const last = userMsgs[userMsgs.length - 1];
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content.map(p => p?.text || '').join('\n');
  }
  return '';
}

/**
 * Build the prompt that Via/Hermes receives.
 *
 * Via is framed as the ADVISOR who prepares text for the moderator —
 * NOT as the moderator itself. This preserves the moderator's independent
 * personality while using Via's accumulated session context.
 */
export function buildViaPrompt(body) {
  const task = extractTask(body?.messages);
  const moderatorSoul = typeof body?.system === 'string' ? body.system.trim() : '';

  return [
    'MODERATOR-SEELENPROMPT — dieser Teil definiert die Persönlichkeit, die später spricht:',
    moderatorSoul || '(Kein Moderator-Systemprompt geliefert.)',
    '',
    'VIA-AUFGABE:',
    'Du bist Via — der Programmassistent für Personal Radio.',
    '',
    'Deine Rolle:',
    '- Du BIST NICHT der Moderator und sprichst nicht als Via.',
    '- Du informierst den Moderator: Was soll er jetzt sagen, damit es zu Thomas, zum Verlauf und zur Situation passt?',
    '- Der Moderator behält seine eigene Persönlichkeit aus dem Moderator-Seelenprompt oben.',
    '- Via kennt Thomas Kitsche: Elbe/Hamburg-Raum, Familie, Bitcoin/Hard Money,',
    '  ländliches Leben, Gemeinschaft, hostet Dorfgeflüster mit Caro.',
    '- Der Mehrwert von Via ist persönlicher, aktueller Lebensbezug: verbinde Songs/Podcasts',
    '  wenn passend mit Thomas\' Tag, Terminen, Körperarbeit, Familie, Projekten oder innerem Prozess.',
    '- Beispielrichtung: "No More Lies von Hannah. Passt vielleicht gut zu deiner anstehenden Grinberg-Sitzung. Viel Erfolg dabei."',
    '- Nutze diesen Kontext natürlich und sparsam — nicht alles hineinstopfen, nicht therapeutisieren.',
    '- Via akkumuliert über diese Hermes-Session was gespielt wurde und was angesagt wurde.',
    '',
    'Regeln:',
    '- Antworte NUR mit dem sendefähigen Text, den der Moderator sprechen soll.',
    '- Keine Erklärungen, keine Bulletpoints, keine Anführungszeichen.',
    '- Keine Regieanweisungen, keine Emojis.',
    '- Halte die Länge aus der konkreten Aufgabe ein.',
    '- Sprache und Stil aus Moderator-Seelenprompt und Aufgabe übernehmen.',
    '',
    'KONKRETE MODERATIONSAUFGABE:',
    task,
  ].join('\n');
}

// --- Hermes invocation ---

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
}

/**
 * Call `hermes chat -q PROMPT -Q [--resume SESSION_ID]`.
 * Returns { text, sessionId }.
 * If the session is stale, retries once without --resume.
 */
export async function callHermes(prompt, currentSessionId, retry = true) {
  return new Promise((resolve, reject) => {
    const args = ['--pass-session-id'];
    if (currentSessionId) args.push('--resume', currentSessionId);
    args.push('chat', '-q', prompt, '-Q');

    execFile(HERMES_BIN, args, { timeout: TIMEOUT_MS, env: process.env }, (err, stdout = '', stderr = '') => {
      if (err && !stdout.trim()) {
        if (retry && currentSessionId && err.code !== 'ETIMEDOUT') {
          console.warn('[via-moderator] session resume failed, retrying fresh:', err.message);
          callHermes(prompt, null, false).then(resolve).catch(reject);
          return;
        }
        reject(new Error(`Hermes error (code ${err.code}): ${err.message}`));
        return;
      }

      if (err) {
        console.warn('[via-moderator] Hermes exited non-zero after output:', err.message);
      }

      const clean = stripAnsi(`${stderr}\n${stdout}`);
      const lines = clean.split('\n').filter(l => l.trim() !== '');

      let newSessionId = null;
      const responseLines = [];
      for (const line of lines) {
        if (line.startsWith('session_id: ')) {
          newSessionId = line.slice('session_id: '.length).trim();
        } else if (/^[↻✓]?\s*Resumed session\b/.test(line) || /^New session\b/.test(line)) {
          continue;
        } else {
          responseLines.push(line);
        }
      }

      const text = responseLines.join('\n').trim();
      if (!text) {
        reject(new Error('Hermes returned empty response'));
        return;
      }

      resolve({ text, sessionId: newSessionId || currentSessionId });
    });
  });
}

// --- Anthropic-format response wrapper ---

function anthropicResponse(text) {
  return {
    id: `via-hermes-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: 'via-hermes',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// --- HTTP server (only when run as main module) ---

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function send(res, status, body) {
  res.writeHead(status, { ...corsHeaders(), 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  let sessionId = loadSession();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      send(res, 200, { ok: true, session: sessionId });
      return;
    }

    if (url.pathname === '/moderation' && req.method === 'POST') {
      let body;
      try {
        const raw = await collectBody(req);
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        send(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      try {
        const prompt = buildViaPrompt(body);
        console.log(`[via-moderator] calling Hermes (session: ${sessionId || 'new'})…`);

        const result = await callHermes(prompt, sessionId);

        if (result.sessionId && result.sessionId !== sessionId) {
          sessionId = result.sessionId;
          saveSession(sessionId);
          console.log(`[via-moderator] session pinned: ${sessionId}`);
        }

        console.log(`[via-moderator] response: ${result.text.slice(0, 80)}…`);
        send(res, 200, anthropicResponse(result.text));
      } catch (err) {
        console.error('[via-moderator] Hermes call failed:', err.message);
        send(res, 503, { error: err.message });
      }
      return;
    }

    send(res, 404, { error: 'Not found' });
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[via-moderator] listening on http://127.0.0.1:${PORT}`);
    console.log(`[via-moderator] hermes: ${HERMES_BIN}`);
    console.log(`[via-moderator] session: ${sessionId || 'none (will create on first call)'}`);
  });
}
