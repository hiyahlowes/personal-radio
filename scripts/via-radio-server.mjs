#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Radio engine internal endpoint (radio-engine.mjs binds here)
const ENGINE_PORT = Number(process.env.RADIO_ENGINE_PORT || 8898);
const ENGINE_HOST = process.env.RADIO_ENGINE_HOST || '127.0.0.1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const port = Number(process.env.PORT || 8899);
const host = process.env.HOST || '0.0.0.0';
const LIVE_STREAM_SOURCE = process.env.PERSONAL_RADIO_STREAM_SOURCE || 'personal_radio_stream.monitor';
const LIVE_STREAM_BITRATE = process.env.PERSONAL_RADIO_STREAM_BITRATE || '128k';
const LIVE_STREAM_REQUIRE_TAILSCALE = !/^(0|false|no|off)$/i.test(process.env.PERSONAL_RADIO_STREAM_REQUIRE_TAILSCALE || 'true');
const configuredLiveStreamClientMaxMs = Number(process.env.PERSONAL_RADIO_STREAM_CLIENT_MAX_MS);
const LIVE_STREAM_CLIENT_MAX_MS = Number.isFinite(configuredLiveStreamClientMaxMs) && configuredLiveStreamClientMaxMs > 0
  ? Math.max(60_000, configuredLiveStreamClientMaxMs)
  : 3 * 60 * 60_000;

// Load a simple KEY=VALUE .env file without printing secrets.
try {
  const env = await fs.readFile(path.join(root, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (!process.env[key]) process.env[key] = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
  }
} catch {}

const { handler: podcastProxy } = await import(pathToFileURL(path.join(root, 'netlify/functions/podcast-proxy.mjs')).href);
const { handler: wavlakeCharts } = await import(pathToFileURL(path.join(root, 'netlify/functions/wavlake-charts.mjs')).href);
const { handler: wavlakePay } = await import(pathToFileURL(path.join(root, 'netlify/functions/wavlake-pay.mjs')).href);
const { default: claudeProxy } = await import(pathToFileURL(path.join(root, 'netlify/functions/claude-proxy.mjs')).href);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const liveClients = new Map();
let liveClientSeq = 0;
let liveEncoder = null;
let liveEncoderStartedAt = null;
let liveBytes = 0;
let liveLastError = '';
let liveStopTimer = null;

function normalizeRemoteAddress(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function isTailscaleOrLocalAddress(address) {
  if (address === '127.0.0.1' || address === '::1' || address === 'localhost') return true;
  if (address.startsWith('fd7a:115c:a1e0:')) return true;
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function streamClientAllowed(req) {
  if (!LIVE_STREAM_REQUIRE_TAILSCALE) return true;
  return isTailscaleOrLocalAddress(normalizeRemoteAddress(req));
}

function liveClientDetails() {
  const now = Date.now();
  return Array.from(liveClients.values()).map(client => ({
    id: client.id,
    remoteAddress: client.remoteAddress,
    userAgent: client.userAgent,
    connectedAt: client.connectedAt.toISOString(),
    ageSeconds: Math.max(0, Math.floor((now - client.connectedAt.getTime()) / 1000)),
    bytesWritten: client.bytesWritten,
    lastWriteAt: client.lastWriteAt?.toISOString() || null,
    backpressureCount: client.backpressureCount,
  }));
}

function removeLiveClient(id, reason = 'removed') {
  const client = liveClients.get(id);
  if (!client) return;
  liveClients.delete(id);
  try {
    if (!client.res.destroyed && !client.res.writableEnded) client.res.end();
  } catch {}
  const ageSeconds = Math.max(0, Math.floor((Date.now() - client.connectedAt.getTime()) / 1000));
  console.log(`[live-stream] client #${id} closed (${reason}) after ${ageSeconds}s, ${client.bytesWritten} bytes`);
  scheduleLiveEncoderStop();
}

function pruneLiveClients(reason = 'prune') {
  const now = Date.now();
  for (const client of liveClients.values()) {
    const ageMs = now - client.connectedAt.getTime();
    if (client.res.destroyed || client.res.writableEnded) {
      removeLiveClient(client.id, `${reason}:closed`);
    } else if (ageMs > LIVE_STREAM_CLIENT_MAX_MS) {
      removeLiveClient(client.id, `${reason}:max-age`);
    }
  }
}

function startLiveEncoder() {
  if (liveEncoder) return liveEncoder;
  if (liveStopTimer) {
    clearTimeout(liveStopTimer);
    liveStopTimer = null;
  }

  liveBytes = 0;
  liveLastError = '';
  liveEncoderStartedAt = new Date();
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'warning',
    '-f', 'pulse',
    '-i', LIVE_STREAM_SOURCE,
    '-vn',
    '-ac', '2',
    '-ar', '44100',
    '-codec:a', 'libmp3lame',
    '-b:a', LIVE_STREAM_BITRATE,
    '-f', 'mp3',
    'pipe:1',
  ];
  liveEncoder = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`[live-stream] ffmpeg started: ${LIVE_STREAM_SOURCE} -> ${LIVE_STREAM_BITRATE} mp3`);

  liveEncoder.stdout.on('data', chunk => {
    liveBytes += chunk.length;
    pruneLiveClients('write');
    for (const client of liveClients.values()) {
      try {
        if (client.res.destroyed || client.res.writableEnded) {
          removeLiveClient(client.id, 'write:closed');
          continue;
        }
        const ok = client.res.write(chunk);
        client.bytesWritten += chunk.length;
        client.lastWriteAt = new Date();
        if (!ok) client.backpressureCount += 1;
      } catch (err) {
        liveLastError = err.message;
        removeLiveClient(client.id, `write-error:${err.message}`);
      }
    }
  });
  liveEncoder.stderr.on('data', chunk => {
    const text = chunk.toString().trim();
    if (text) {
      liveLastError = text.slice(-500);
      console.warn(`[live-stream] ${text}`);
    }
  });
  liveEncoder.on('error', err => {
    liveLastError = err.message;
    console.error('[live-stream] ffmpeg spawn error:', err.message);
  });
  liveEncoder.on('close', code => {
    console.warn(`[live-stream] ffmpeg stopped with code ${code}`);
    liveEncoder = null;
    liveEncoderStartedAt = null;
    for (const client of liveClients.values()) {
      try {
        if (!client.res.destroyed && !client.res.writableEnded) client.res.end();
      } catch {}
    }
    liveClients.clear();
  });
  return liveEncoder;
}

function scheduleLiveEncoderStop() {
  if (liveClients.size > 0 || !liveEncoder || liveStopTimer) return;
  liveStopTimer = setTimeout(() => {
    liveStopTimer = null;
    if (liveClients.size === 0 && liveEncoder) {
      console.log('[live-stream] no clients, stopping ffmpeg');
      try { liveEncoder.kill('SIGTERM'); } catch {}
    }
  }, 30_000);
}

function liveStreamStatus() {
  pruneLiveClients('status');
  return {
    ok: true,
    source: LIVE_STREAM_SOURCE,
    bitrate: LIVE_STREAM_BITRATE,
    requireTailscale: LIVE_STREAM_REQUIRE_TAILSCALE,
    maxClientAgeSeconds: Math.floor(LIVE_STREAM_CLIENT_MAX_MS / 1000),
    clients: liveClients.size,
    clientDetails: liveClientDetails(),
    encoderRunning: !!liveEncoder,
    startedAt: liveEncoderStartedAt?.toISOString() || null,
    bytes: liveBytes,
    lastError: liveLastError || null,
    urls: {
      mp3: '/live.mp3',
      m3u: '/live.m3u',
    },
  };
}

function handleLiveM3u(req, res) {
  if (!streamClientAllowed(req)) {
    return send(res, 403, { 'content-type': 'text/plain; charset=utf-8' }, 'Livestream is available over Tailscale only.\n');
  }
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const hostHeader = req.headers.host || `localhost:${port}`;
  return send(res, 200, {
    'content-type': 'audio/x-mpegurl; charset=utf-8',
    'cache-control': 'no-store',
  }, `#EXTM3U\n#EXTINF:-1,PR Personal Radio\n${proto}://${hostHeader}/live.mp3\n`);
}

function handleLiveMp3(req, res) {
  if (!streamClientAllowed(req)) {
    return send(res, 403, { 'content-type': 'text/plain; charset=utf-8' }, 'Livestream is available over Tailscale only.\n');
  }
  res.writeHead(200, {
    'content-type': 'audio/mpeg',
    'cache-control': 'no-store, no-transform',
    'connection': 'close',
    'access-control-allow-origin': '*',
    'icy-name': 'PR Personal Radio',
    'icy-metaint': '0',
  });
  const id = ++liveClientSeq;
  const client = {
    id,
    res,
    remoteAddress: normalizeRemoteAddress(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 160),
    connectedAt: new Date(),
    bytesWritten: 0,
    lastWriteAt: null,
    backpressureCount: 0,
  };
  liveClients.set(id, client);
  console.log(`[live-stream] client #${id} connected from ${client.remoteAddress} ${client.userAgent}`);
  startLiveEncoder();
  const cleanup = reason => removeLiveClient(id, reason);
  req.on('close', () => cleanup('request-close'));
  req.on('aborted', () => cleanup('request-aborted'));
  req.on('error', err => cleanup(`request-error:${err.message}`));
  res.on('close', () => cleanup('response-close'));
  res.on('error', err => cleanup(`response-error:${err.message}`));
}

function send(res, status, headers, body = '') {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    if (body) res.write(body);
    return res.end();
  }
  res.writeHead(status, headers);
  res.end(body);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleNetlifyHandler(handler, req, res, url) {
  const body = await collectBody(req);
  const event = {
    httpMethod: req.method,
    path: url.pathname,
    headers: req.headers,
    rawUrl: `http://localhost:${port}${req.url}`,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    body: body.length ? body.toString('utf8') : null,
    isBase64Encoded: false,
  };
  const out = await handler(event);
  const headers = out.headers || {};
  const responseBody = out.isBase64Encoded ? Buffer.from(out.body || '', 'base64') : (out.body || '');
  send(res, out.statusCode || 200, headers, responseBody);
}

async function handlePodcastProxy(req, res, url) {
  return handleNetlifyHandler(podcastProxy, req, res, url);
}

async function handleClaudeProxy(req, res) {
  const body = await collectBody(req);
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : body,
  });
  const out = await claudeProxy(request);
  const headers = Object.fromEntries(out.headers.entries());
  const responseBody = Buffer.from(await out.arrayBuffer());
  send(res, out.status, headers, responseBody);
}

async function handlePodcastStream(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    return send(res, 400, { 'content-type': 'application/json' }, JSON.stringify({ error: 'Missing or invalid url' }));
  }
  const headers = { 'User-Agent': 'PersonalRadio/1.0 (local stream)' };
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = await fetch(target, { headers, redirect: 'follow' });
  const outHeaders = {
    'access-control-allow-origin': '*',
    'content-type': upstream.headers.get('content-type') || 'audio/mpeg',
    'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes',
  };
  for (const h of ['content-length', 'content-range', 'cache-control']) {
    const v = upstream.headers.get(h);
    if (v) outHeaders[h] = v;
  }
  res.writeHead(upstream.status, outHeaders);
  if (upstream.body) {
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  }
  res.end();
}

// ── Radio engine proxy ────────────────────────────────────────────────────────

/**
 * Proxy /api/* to the internal radio-engine on ENGINE_HOST:ENGINE_PORT.
 * SSE (/api/events) is passed through as a streaming pipe.
 */
async function proxyToEngine(req, res, url) {
  const target = `http://${ENGINE_HOST}:${ENGINE_PORT}${url.pathname}${url.search || ''}`;

  // SSE needs a streaming pipe, not a buffered fetch.
  if (url.pathname === '/api/events') {
    return new Promise((resolve, reject) => {
      const engineReq = http.request(target, { method: 'GET', headers: req.headers }, engineRes => {
        res.writeHead(engineRes.statusCode || 200, {
          ...engineRes.headers,
          'cache-control': 'no-cache',
          'connection':    'keep-alive',
          'access-control-allow-origin': '*',
        });
        engineRes.pipe(res);
        engineRes.on('end', resolve);
        engineRes.on('error', reject);
      });
      engineReq.on('error', err => {
        if (!res.headersSent) {
          res.writeHead(503, { 'content-type': 'text/event-stream' });
          res.end(`event: error\ndata: ${JSON.stringify({ error: 'engine unavailable' })}\n\n`);
        }
        resolve();
      });
      req.on('close', () => engineReq.destroy());
      engineReq.end();
    });
  }

  // Regular JSON API call
  const body = await collectBody(req);
  let engineRes;
  try {
    engineRes = await fetch(target, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      body: body.length ? body : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return send(res, 503, { 'content-type': 'application/json' }, JSON.stringify({ error: 'radio engine unavailable' }));
  }

  const text = await engineRes.text();
  send(res, engineRes.status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  }, text);
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  let file = path.normalize(path.join(dist, rel));
  if (!file.startsWith(dist)) return send(res, 403, { 'content-type': 'text/plain' }, 'Forbidden');
  if (!existsSync(file)) file = path.join(dist, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': mime[ext] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    if (url.pathname === '/health') return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true }));
    if (url.pathname === '/live.mp3') return handleLiveMp3(req, res);
    if (url.pathname === '/live.m3u') return handleLiveM3u(req, res);
    if (url.pathname === '/api/live-stream/status') {
      return send(res, 200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      }, JSON.stringify(liveStreamStatus()));
    }
    if (url.pathname.startsWith('/api/')) return await proxyToEngine(req, res, url);
    if (url.pathname === '/.netlify/functions/podcast-proxy') return await handlePodcastProxy(req, res, url);
    if (url.pathname === '/.netlify/functions/wavlake-charts') return await handleNetlifyHandler(wavlakeCharts, req, res, url);
    if (url.pathname === '/.netlify/functions/wavlake-pay') return await handleNetlifyHandler(wavlakePay, req, res, url);
    if (url.pathname === '/.netlify/functions/claude-proxy') return await handleClaudeProxy(req, res);
    if (url.pathname === '/podcast-stream') return await handlePodcastStream(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    if (res.destroyed || res.writableEnded || res.headersSent) return;
    console.error('[via-radio-server]', err);
    return send(res, 500, { 'content-type': 'application/json' }, JSON.stringify({ error: String(err?.message || err) }));
  }
});

server.listen(port, host, () => {
  console.log(`[via-radio-server] listening on http://${host}:${port}`);
});
