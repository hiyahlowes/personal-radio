#!/usr/bin/env node
/**
 * Personal Radio Engine v2
 *
 * Central audio player with:
 * - Multi-output: independent ffplay per sink (no combine-sink → no underflows)
 * - Item types: music | moderation | podcast
 * - HTTP/SSE API proxied via via-radio-server :8899
 *
 * Internal: RADIO_ENGINE_HOST:RADIO_ENGINE_PORT (default 127.0.0.1:8898)
 *
 * Outputs (configurable via RADIO_OUTPUTS JSON env var):
 *   cleo  → bluez_output.EC_81_93_4A_9D_E7.1
 *   deck  → via_pi2_living_combined
 *
 * Queue item types:
 *   music       — Wavlake track, play URL via ffplay
 *   moderation  — Text → TTS MP3 via podcast-proxy → ffplay temp file
 *   podcast     — resumable server-side segment → ffplay -ss/-t
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, readdirSync, statSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir, homedir } from 'node:os';
import process from 'node:process';
import { createHash } from 'node:crypto';
import {
  addCallIn,
  archiveCallIn,
  listCallIns,
  loadMemory,
  markCallInsUsed,
  recordModeration,
  recordPodcastSegment,
  recordTrackBanned,
  recordTrackFinished,
  recordTrackLiked,
  recordTrackSkipped,
  recordTrackStarted,
  rememberRecentTrack,
} from './radio-memory.mjs';
import {
  buildMusicModerationContext,
  buildPodcastIntroContext,
  buildPodcastModerationContext,
} from './radio-context.mjs';

// ── Config ────────────────────────────────────────────────────────────────────

// Load .env without printing secrets. The engine needs non-VITE and VITE voice IDs
// for server-side TTS defaults in remote mode.
try {
  const envPath = path.join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    const env = readFileSync(envPath, 'utf8');
    for (const line of env.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [key, ...rest] = trimmed.split('=');
      if (!process.env[key]) process.env[key] = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
    }
  }
} catch {}

const PORT = Number(process.env.RADIO_ENGINE_PORT || 8898);
const HOST = process.env.RADIO_ENGINE_HOST        || '127.0.0.1';

const DATA_DIR       = process.env.RADIO_DATA_DIR          || path.join(homedir(), '.config', 'personal-radio');
const BLOCKLIST_FILE = process.env.PERSONAL_RADIO_BLOCKLIST || path.join(DATA_DIR, 'blocked-tracks.txt');
const LIKED_FILE     = path.join(DATA_DIR, 'liked-tracks.json');
const SETTINGS_FILE  = path.join(DATA_DIR, 'settings.json');
const PODCAST_STATE_FILE = path.join(DATA_DIR, 'podcast-state.json');
const PODCAST_TRANSCRIPT_DIR = path.join(DATA_DIR, 'podcast-transcripts');
const AUDIO_ANALYSIS_FILE = path.join(DATA_DIR, 'audio-analysis.json');
const TMP_DIR        = path.join(tmpdir(), 'personal-radio');
const PUBLIC_DIR     = path.join(process.cwd(), 'public');
const MODERATOR_SOUL_FILE = process.env.PERSONAL_RADIO_MODERATOR_SOUL || path.join(process.cwd(), 'config', 'moderator-soul.md');

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw);
}

const APP_PORT   = Number(process.env.APP_PORT || 8899);
const MANUAL_START_GRACE_MS = Math.max(5_000, Number(process.env.PERSONAL_RADIO_MANUAL_START_GRACE_MS || 45_000));
const CHARTS_URL = `http://127.0.0.1:${APP_PORT}/.netlify/functions/wavlake-charts`;
const WAVLAKE_PLAYLIST_URL = 'https://catalog.wavlake.com/v1/playlists';
const TTS_ELEVEN_URL = `http://127.0.0.1:${APP_PORT}/.netlify/functions/podcast-proxy?action=tts`;
const TTS_FISH_URL   = `http://127.0.0.1:${APP_PORT}/.netlify/functions/podcast-proxy?action=tts-fish`;
const PODCAST_TEXT_URL = `http://127.0.0.1:${APP_PORT}/.netlify/functions/podcast-proxy?action=text`;
const PODCAST_STT_URL  = `http://127.0.0.1:${APP_PORT}/.netlify/functions/podcast-proxy?action=stt`;
const PODCAST_AUDIO_RESOLVER_URL = `http://127.0.0.1:${APP_PORT}/.netlify/functions/podcast-proxy?action=audioresolver`;
// Moderation text via claude-proxy (direct Anthropic API, fast ~2-3s).
// Falls back to via-moderator only if PERSONAL_RADIO_USE_VIA=true is set.
const CLAUDE_URL = `http://127.0.0.1:${APP_PORT}/.netlify/functions/claude-proxy`;

const TTS_LANG     = process.env.TTS_LANG    || 'de';
const PODCAST_URL  = process.env.PODCAST_FEED_URL || 'https://feeds.fountain.fm/UZSKQcrOnhqYS1JopxGg';
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || process.env.ASSEMBLY_AI_API_KEY || '';

const MODERATION_AFTER_SONGS = Number(process.env.MODERATION_AFTER_SONGS || 3);
const PODCAST_AFTER_SONGS    = Number(process.env.PODCAST_AFTER_SONGS    || 6);
const CACHE_HTTP_AUDIO        = envFlag('PERSONAL_RADIO_CACHE_HTTP_AUDIO', false);
const PLAYBACK_PREFETCH_ENABLED = envFlag('PERSONAL_RADIO_PLAYBACK_PREFETCH', true);
const PLAYBACK_PREFETCH_TTL_MS = Number(process.env.PERSONAL_RADIO_PLAYBACK_PREFETCH_TTL_MS || 2 * 60 * 60_000);
const PULSE_LATENCY_MSEC      = process.env.PULSE_LATENCY_MSEC || '350';
const FFPLAY_ANALYZE_DURATION = process.env.PERSONAL_RADIO_FFPLAY_ANALYZE_DURATION || '1000000';
const FFPLAY_PROBE_SIZE       = process.env.PERSONAL_RADIO_FFPLAY_PROBE_SIZE || '1000000';
const FFPLAY_AUDIO_FILTER     = process.env.PERSONAL_RADIO_FFPLAY_AUDIO_FILTER || 'aresample=async=1000:first_pts=0';
const TTS_TAIL_PAD_SECONDS    = Number(process.env.PERSONAL_RADIO_TTS_TAIL_PAD_SECONDS || 1.2);
const TTS_FILE_TAIL_SILENCE_SECONDS = Number(process.env.PERSONAL_RADIO_TTS_FILE_TAIL_SILENCE_SECONDS || 1.0);
const TTS_KEEP_RECENT_FILES   = Number(process.env.PERSONAL_RADIO_TTS_KEEP_RECENT_FILES || 10);
const DEFAULT_CROSSFADE_SECONDS = Number(process.env.PERSONAL_RADIO_CROSSFADE_SECONDS || 5);
const DEFAULT_MODERATION_DUCK_SECONDS = Number(process.env.PERSONAL_RADIO_MODERATION_DUCK_SECONDS || 4);
const AUDIO_ANALYSIS_VERSION = 2;
const DEFAULT_AUDIO_ANALYSIS_WINDOW_SECONDS = Number(process.env.PERSONAL_RADIO_AUDIO_ANALYSIS_WINDOW_SECONDS || 45);
const AUDIO_ANALYSIS_PREFETCH_LIMIT = Number(process.env.PERSONAL_RADIO_AUDIO_ANALYSIS_PREFETCH_LIMIT || 4);
const PODCAST_INTRO_JINGLE    = process.env.PERSONAL_RADIO_PODCAST_INTRO_JINGLE || path.join(PUBLIC_DIR, 'podcast-intro.mp3');
const PODCAST_RETURN_JINGLE   = process.env.PERSONAL_RADIO_PODCAST_RETURN_JINGLE || path.join(PUBLIC_DIR, 'studio-return.mp3');
const PODCAST_RESOLVED_URL_TTL_MS = Number(process.env.PERSONAL_RADIO_PODCAST_RESOLVED_URL_TTL_MS || 45 * 60_000);
const PODCAST_SEGMENT_CACHE_ENABLED = envFlag('PERSONAL_RADIO_PODCAST_SEGMENT_CACHE', true);
const PODCAST_SEGMENT_PREFETCH_TTL_MS = Number(process.env.PERSONAL_RADIO_PODCAST_SEGMENT_PREFETCH_TTL_MS || 30 * 60_000);
const PODCAST_SEGMENT_PREFETCH_MAX = Number(process.env.PERSONAL_RADIO_PODCAST_SEGMENT_PREFETCH_MAX || 4);

// Two independent outputs — each gets its own ffplay process per track.
// Override with: RADIO_OUTPUTS='[{"name":"cleo","sink":"bluez_output.EC_81_93_4A_9D_E7.1"},{"name":"deck","sink":"via_pi2_living_combined"}]'
const OUTPUTS = JSON.parse(process.env.RADIO_OUTPUTS || JSON.stringify([
  { name: 'cleo', sink: 'bluez_output.EC_81_93_4A_9D_E7.1' },
  { name: 'deck', sink: 'via_pi2_living_combined' },
]));

const DEFAULT_SETTINGS = {
  satStreamingEnabled: false,
  boostAmountSats: 100,
  satRatePerMinute: 10,
  supportPREnabled: false,
  prSplitPercent: 20,
  moderationEnabled: MODERATION_AFTER_SONGS > 0,
  moderationAfterSongs: MODERATION_AFTER_SONGS,
  crossfadeEnabled: true,
  crossfadeSeconds: Number.isFinite(DEFAULT_CROSSFADE_SECONDS) && DEFAULT_CROSSFADE_SECONDS > 0 ? DEFAULT_CROSSFADE_SECONDS : 5,
  moderationDuckingEnabled: true,
  moderationDuckSeconds: Number.isFinite(DEFAULT_MODERATION_DUCK_SECONDS) && DEFAULT_MODERATION_DUCK_SECONDS > 0 ? DEFAULT_MODERATION_DUCK_SECONDS : 4,
  audioAnalysisEnabled: true,
  audioAnalysisWindowSeconds: Number.isFinite(DEFAULT_AUDIO_ANALYSIS_WINDOW_SECONDS) && DEFAULT_AUDIO_ANALYSIS_WINDOW_SECONDS > 0 ? DEFAULT_AUDIO_ANALYSIS_WINDOW_SECONDS : 45,
  transitionIntroAnalysisEnabled: true,
  transitionIntroSkipMaxSeconds: 8,
  recentTrackCooldownMinutes: 180,
  musicSource: 'topCharts',
  wavlakePlaylistId: '',
  wavlakePlaylistTitle: '',
  wavlakePlaylists: [],
  podcastAfterSongs: PODCAST_AFTER_SONGS,
  podcastFeedUrl: PODCAST_URL,
  podcastFeeds: [],
  podcastQueue: [],
  podcastsEnabled: true,
  podcastSegmentMinMinutes: 8,
  podcastSegmentMaxMinutes: 15,
  podcastSttFallbackEnabled: true,
  podcastPreferTranscriptChapters: true,
  podcastTranscriptPrefetchEnabled: true,
  podcastTranscriptPrefetchLimit: 5,
  podcastTranscriptProvider: 'assemblyai',
  podcastAdSkipEnabled: true,
  musicBreakTracksAfterPodcast: 0,
  ttsProvider: (process.env.ELEVENLABS_API_KEY && (process.env.VITE_ELEVENLABS_VOICE_ID_DE || process.env.VITE_ELEVENLABS_VOICE_ID)) ? 'elevenlabs' : 'fish',
  elevenLabsVoiceIdEn: process.env.VITE_ELEVENLABS_VOICE_ID || '',
  elevenLabsVoiceIdDe: process.env.VITE_ELEVENLABS_VOICE_ID_DE || process.env.VITE_ELEVENLABS_VOICE_ID || '',
  elevenLabsModelId: 'eleven_v3',
  elevenLabsVoiceSettings: {
    stability: 0.25,
    similarity_boost: 0.78,
    style: 0.75,
    use_speaker_boost: true,
  },
  fishVoiceIdEn: process.env.FISH_AUDIO_VOICE_ID_EN || process.env.FISH_AUDIO_VOICE_ID || '',
  fishVoiceIdDe: process.env.FISH_AUDIO_VOICE_ID_DE || process.env.FISH_AUDIO_VOICE_ID || '',
  autoSuspendWhenNoListeners: true,
  noListenerGraceSeconds: 30,
  streamListenerMaxAgeMinutes: 180,
  newSessionAfterMinutes: 180,
  resumeWithLikedSong: true,
  sessionIntroAfterFirstSong: true,
};

function loadSettings() {
  try {
    if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      elevenLabsVoiceSettings: {
        ...DEFAULT_SETTINGS.elevenLabsVoiceSettings,
        ...(parsed.elevenLabsVoiceSettings && typeof parsed.elevenLabsVoiceSettings === 'object' ? parsed.elevenLabsVoiceSettings : {}),
      },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next) {
  mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
}

function loadAudioAnalysisCache() {
  try {
    if (!existsSync(AUDIO_ANALYSIS_FILE)) return { version: AUDIO_ANALYSIS_VERSION, tracks: {} };
    const parsed = JSON.parse(readFileSync(AUDIO_ANALYSIS_FILE, 'utf8'));
    if (parsed?.version !== AUDIO_ANALYSIS_VERSION || !parsed.tracks || typeof parsed.tracks !== 'object') {
      return { version: AUDIO_ANALYSIS_VERSION, tracks: {} };
    }
    return parsed;
  } catch {
    return { version: AUDIO_ANALYSIS_VERSION, tracks: {} };
  }
}

function saveAudioAnalysisCache() {
  try {
    mkdirSync(path.dirname(AUDIO_ANALYSIS_FILE), { recursive: true });
    writeFileSync(AUDIO_ANALYSIS_FILE, JSON.stringify(audioAnalysisCache, null, 2));
  } catch (err) {
    console.warn(`[engine] audio analysis cache save failed: ${err.message}`);
  }
}

function loadModeratorSoul() {
  try {
    if (existsSync(MODERATOR_SOUL_FILE)) {
      const text = readFileSync(MODERATOR_SOUL_FILE, 'utf8').trim();
      if (text) return text;
    }
  } catch (err) {
    console.warn(`[engine] moderator soul load failed: ${err.message}`);
  }
  return [
    'Du bist der Moderator von PR, Personal Radio.',
    'Du bist warm, locker, direkt, klug und persoenlich.',
    'Du klingst wie ein echter Radiomoderator, nicht wie ein Nachrichtensprecher.',
    'Du darfst Haltung haben, aber du bleibst kurz, sendefaehig und ehrlich.',
  ].join('\n');
}

const MODERATOR_SOUL = loadModeratorSoul();

function moderatorSystemPrompt(rules) {
  return [
    MODERATOR_SOUL,
    '',
    'AKTUELLE MODERATIONSAUFGABE:',
    rules,
    '',
    'Antworte NUR mit dem direkt sendefaehigen Text. Keine Erklaerungen, keine Bulletpoints, keine Anfuehrungszeichen.',
  ].filter(Boolean).join('\n');
}

function sanitizeModerationText(text) {
  if (text == null) return '';
  const original = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!original) return '';
  const lines = original
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (!line) return false;
      if (/^Session\s+\S+\s+found but has no messages\.?\s*$/i.test(line)) return false;
      if (/^Starting fresh\.?$/i.test(line)) return false;
      if (/^Session\s+\S+\s+found but has no messages\.?\s*Starting fresh\.?$/i.test(line)) return false;
      if (/^(debug|info|warning|error|trace)\s*:/i.test(line)) return false;
      return true;
    });
  const cleaned = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned !== original) {
    console.warn(`[engine] sanitized moderation text (${original.length} -> ${cleaned.length} chars)`);
  }
  return cleaned;
}

function normalizeWavlakePlaylists(settings = engineSettings) {
  const rows = Array.isArray(settings.wavlakePlaylists) ? settings.wavlakePlaylists : [];
  const normalized = rows
    .map(row => typeof row === 'string' ? { id: row } : row)
    .map(row => ({
      id: String(row?.id || '').trim(),
      title: String(row?.title || '').trim(),
    }))
    .filter(row => row.id);
  if (normalized.length === 0 && settings.wavlakePlaylistId) {
    normalized.push({
      id: String(settings.wavlakePlaylistId).trim(),
      title: String(settings.wavlakePlaylistTitle || '').trim(),
    });
  }
  return [...new Map(normalized.map(row => [row.id, row])).values()];
}

function loadPodcastState() {
  try {
    if (!existsSync(PODCAST_STATE_FILE)) {
      return { episodes: {}, currentEpisodeKey: null, active: null, lastSegment: null, breakSongsRemaining: 0 };
    }
    const parsed = JSON.parse(readFileSync(PODCAST_STATE_FILE, 'utf8'));
    return {
      episodes: parsed.episodes && typeof parsed.episodes === 'object' ? parsed.episodes : {},
      currentEpisodeKey: parsed.currentEpisodeKey || null,
      active: parsed.active || null,
      lastSegment: parsed.lastSegment || null,
      breakSongsRemaining: Number(parsed.breakSongsRemaining || 0),
    };
  } catch {
    return { episodes: {}, currentEpisodeKey: null, active: null, lastSegment: null, breakSongsRemaining: 0 };
  }
}

function savePodcastState() {
  mkdirSync(path.dirname(PODCAST_STATE_FILE), { recursive: true });
  writeFileSync(PODCAST_STATE_FILE, JSON.stringify(podcastState, null, 2));
}

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {{ kind: string, id?: string, title: string, artist: string, artworkUrl?: string, liveUrl: string, duration: number }|null} */
let currentItem  = null;
let playing      = false;
let paused       = false;
let startedAt    = null;
let queue        = [];
let songCount    = 0;   // naturally completed songs since last moderation
let podcastCount = 0;   // naturally completed songs since last podcast
let podcastBreakSongsRemaining = 0; // music tracks required after a podcast segment
let itemWasKilled = false; // true when current item was skip/ban/pause-killed
let engineSettings = loadSettings();
let audioAnalysisCache = loadAudioAnalysisCache();
const audioAnalysisInFlight = new Map();
const playbackAudioCache = new Map();
const playbackAudioPrefetches = new Map();
let forcedNextItem = null;
let podcastState = loadPodcastState();
podcastBreakSongsRemaining = Number(podcastState.breakSongsRemaining || 0);
let currentPodcastPlayback = null;
let podcastSegmentSkipRequested = false;
let podcastSessionActive = false;
let shuttingDown = false;
let pausedResumeItem = null;
let currentPlaybackStartSeconds = 0;
let deferredResumeItem = null;
let sessionIntroRequest = null;
let pendingSessionIntroPromise = null;
let sessionIntroSongKey = null;
let listenerResumeInProgress = false;
let nextMusicFadeInSeconds = 0;
let manualStartGraceUntil = 0;
let manualStartGraceReason = null;

const RESUME_END_GUARD_SECONDS = 5;

const listenerState = {
  mode: 'unknown',
  activeListeners: 0,
  activeOutputs: [],
  outputDetails: [],
  liveStreamClients: null,
  freshLiveStreamClients: null,
  lastCheckedAt: null,
  lastHeardAt: null,
  graceStartedAt: null,
  suspendedAt: null,
  lastResumedAt: null,
  lastSuspendDurationSeconds: 0,
  silenceDurationSeconds: 0,
  resumeWillStartNewSession: false,
  reason: null,
};

// Pre-generated moderation ready to play: Promise<ModerationItem|null>|null
let pendingModerationPromise = null;
let pendingModerationPlan = null;
let pendingPodcastIntroPromise = null;
let pendingPodcastIntroKey = null;
const podcastSegmentPrefetches = new Map();
const preparedPodcastSegmentCache = new Map();
let coveredPodcastIntroKey = null;

// Per-output state
const outputState = {};
for (const o of OUTPUTS) {
  outputState[o.name] = { playing: false, error: null, pid: null, sink: o.sink };
}

// Active ffplay processes. Music crossfade may briefly run two processes per output.
let activeProcs = new Map();
// Cancellation token for the current playback
let skipToken = { cancelled: false };

function activeProcKey(outputName, proc) {
  return `${outputName}:${proc.pid || Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function activeProcCountForOutput(outputName) {
  let count = 0;
  for (const proc of activeProcs.values()) {
    if (proc.__personalRadioOutput === outputName) count++;
  }
  return count;
}

function markOutputStoppedIfIdle(outputName) {
  if (activeProcCountForOutput(outputName) > 0) return;
  outputState[outputName].playing = false;
  outputState[outputName].pid = null;
}

// ── Blocklist ─────────────────────────────────────────────────────────────────

function loadBlocked() {
  try {
    if (!existsSync(BLOCKLIST_FILE)) return new Set();
    return new Set(
      readFileSync(BLOCKLIST_FILE, 'utf8')
        .split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    );
  } catch { return new Set(); }
}

function blockTrack(item) {
  try {
    mkdirSync(path.dirname(BLOCKLIST_FILE), { recursive: true });
    const key      = `${item.artist} — ${item.title}`;
    const existing = existsSync(BLOCKLIST_FILE)
      ? readFileSync(BLOCKLIST_FILE, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      : [];
    if (!existing.includes(key) && !existing.includes(item.liveUrl)) {
      writeFileSync(BLOCKLIST_FILE, [...existing, key].join('\n') + '\n');
    }
  } catch(e) { console.error('[engine] blockTrack:', e.message); }
}

function unblockTrack(value) {
  try {
    const needle = String(value || '').trim();
    if (!needle || !existsSync(BLOCKLIST_FILE)) return loadBlockedRows();
    const rows = readFileSync(BLOCKLIST_FILE, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    const next = rows.filter(row => row !== needle);
    mkdirSync(path.dirname(BLOCKLIST_FILE), { recursive: true });
    writeFileSync(BLOCKLIST_FILE, next.length ? `${next.join('\n')}\n` : '');
    return loadBlockedRows();
  } catch(e) {
    console.error('[engine] unblockTrack:', e.message);
    return loadBlockedRows();
  }
}

function loadBlockedRows() {
  try {
    if (!existsSync(BLOCKLIST_FILE)) return [];
    return readFileSync(BLOCKLIST_FILE, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(value => {
        const parts = value.split(' — ');
        return {
          id: value,
          value,
          title: parts.length > 1 ? parts.slice(1).join(' — ') : value,
          artist: parts.length > 1 ? parts[0] : '',
          url: /^https?:\/\//i.test(value) ? value : '',
        };
      });
  } catch {
    return [];
  }
}

function isBlocked(item) {
  if (item.kind !== 'music') return false;
  const blocked = loadBlocked();
  return blocked.has(`${item.artist} — ${item.title}`) || blocked.has(item.liveUrl);
}

// ── Liked tracks ──────────────────────────────────────────────────────────────

async function loadLiked() {
  try {
    const liked = JSON.parse(await readFile(LIKED_FILE, 'utf8'));
    return Array.isArray(liked) ? liked : [];
  } catch { return []; }
}

async function saveLiked(item) {
  const liked = await loadLiked();
  if (!liked.some(t => t.id === item.id)) {
    liked.push({
      id: item.id,
      title: item.title,
      artist: item.artist,
      artworkUrl: item.artworkUrl || '',
      liveUrl: item.liveUrl || '',
      duration: Number(item.duration || 0),
      albumTitle: item.albumTitle || '',
      likedAt: new Date().toISOString(),
    });
    await mkdir(path.dirname(LIKED_FILE), { recursive: true });
    await writeFile(LIKED_FILE, JSON.stringify(liked, null, 2));
  }
  return liked;
}

async function removeLikedTrack(trackId) {
  const id = String(trackId || '').trim();
  if (!id) return loadLiked();
  const liked = await loadLiked();
  const next = liked.filter(t => String(t.id || '') !== id);
  await mkdir(path.dirname(LIKED_FILE), { recursive: true });
  await writeFile(LIKED_FILE, JSON.stringify(next, null, 2));
  return next;
}

function likedToExportRows(liked) {
  return liked.map(t => ({
    id: t.id,
    title: t.title || t.name || '',
    artist: t.artist || '',
    url: `https://wavlake.com/track/${t.id}`,
    likedAt: t.likedAt || '',
  }));
}

// ── SSE clients ───────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

function broadcastStatus() { broadcast('status', buildStatus()); }

function memorySafe(label, fn) {
  try { return fn(); }
  catch (err) {
    console.warn(`[memory] ${label} failed:`, err.message);
    return null;
  }
}

function itemDurationSeconds(item) {
  const duration = Number(item?.duration ?? item?.durationSeconds ?? item?.duration_seconds);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function clampPlaybackPosition(item, positionSeconds) {
  const position = Math.max(0, Math.floor(Number(positionSeconds || 0)));
  const duration = itemDurationSeconds(item);
  if (!duration) return position;
  return Math.min(position, Math.floor(duration));
}

function playbackPositionSeconds(item = currentItem) {
  if (!startedAt) return clampPlaybackPosition(item, currentPlaybackStartSeconds || 0);
  const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
  return clampPlaybackPosition(item, (currentPlaybackStartSeconds || 0) + elapsed);
}

function normalizeResumeSnapshot(snapshot, reason = 'resume') {
  if (!snapshot?.item) return null;
  const item = { ...snapshot.item };
  delete item.tmpFile;

  const positionSeconds = clampPlaybackPosition(item, snapshot.positionSeconds || 0);
  const duration = itemDurationSeconds(item);
  if (duration && (item.kind === 'music' || item.kind === 'podcast')) {
    const maxUsefulStart = Math.max(0, duration - RESUME_END_GUARD_SECONDS);
    if (positionSeconds >= maxUsefulStart) {
      console.warn(`[engine] dropping stale ${item.kind} resume at ${Math.round(positionSeconds)}s/${Math.round(duration)}s (${reason})`);
      return null;
    }
  }

  return {
    ...snapshot,
    item,
    positionSeconds,
  };
}

function snapshotCurrentForPause() {
  if (!currentItem) return null;
  const positionSeconds = playbackPositionSeconds();
  const item = { ...currentItem };
  delete item.tmpFile;
  return normalizeResumeSnapshot({
    item,
    positionSeconds,
    savedAt: new Date().toISOString(),
  }, 'pause-snapshot');
}

function persistPodcastPausePosition(snapshot) {
  if (!snapshot || snapshot.item?.kind !== 'podcast') return;
  const key = currentPodcastPlayback?.episodeKey || podcastState.currentEpisodeKey || podcastEpisodeKey(snapshot.item);
  const state = key ? podcastState.episodes?.[key] : null;
  if (!key || !state) return;
  state.positionSeconds = Math.max(0, snapshot.positionSeconds);
  state.completed = false;
  podcastState.episodes[key] = state;
  podcastState.currentEpisodeKey = key;
  savePodcastState();
}

// ── Status ────────────────────────────────────────────────────────────────────

function buildStatus() {
  return {
    playing,
    paused,
    currentItem,
    // Keep legacy field name for remote UI compatibility
    currentTrack: currentItem,
    startedAt,
    elapsedSeconds: playbackPositionSeconds(),
    playbackStartSeconds: currentPlaybackStartSeconds,
    pausedResumeItem,
    queueLength: queue.length,
    queue: queue.slice(0, 10),
    podcastQueue: Array.isArray(engineSettings.podcastQueue) ? engineSettings.podcastQueue : [],
    podcastState: buildPodcastStatus(),
    outputs: { ...outputState },
    listenerState: buildListenerStatus(),
    settings: engineSettings,
    source: engineSettings.musicSource === 'wavlakePlaylist'
      ? 'wavlake-playlist'
      : engineSettings.musicSource === 'prLikedSongs'
        ? 'pr-liked-songs'
        : 'wavlake-top40',
    songCount,
  };
}

function buildListenerStatus() {
  const now = Date.now();
  const suspendedAtMs = listenerState.suspendedAt ? Date.parse(listenerState.suspendedAt) : 0;
  const graceStartedAtMs = listenerState.graceStartedAt ? Date.parse(listenerState.graceStartedAt) : 0;
  const silenceDurationSeconds = listenerState.mode === 'suspended' && suspendedAtMs
    ? Math.max(listenerState.silenceDurationSeconds || 0, Math.floor((now - suspendedAtMs) / 1000))
    : listenerState.mode === 'grace' && graceStartedAtMs
      ? Math.floor((now - graceStartedAtMs) / 1000)
      : listenerState.silenceDurationSeconds || 0;
  const thresholdSeconds = Math.max(60, Number(engineSettings.newSessionAfterMinutes ?? 180) * 60);
  return {
    ...listenerState,
    silenceDurationSeconds,
    autoSuspendWhenNoListeners: engineSettings.autoSuspendWhenNoListeners !== false,
    noListenerGraceSeconds: Math.max(0, Number(engineSettings.noListenerGraceSeconds ?? 30)),
    streamListenerMaxAgeMinutes: Math.max(1, streamListenerMaxAgeMinutes()),
    newSessionAfterMinutes: Number(engineSettings.newSessionAfterMinutes ?? 180),
    resumeWillStartNewSession: listenerState.mode === 'suspended'
      ? silenceDurationSeconds >= thresholdSeconds
      : !!listenerState.resumeWillStartNewSession,
    pendingSessionIntro: !!sessionIntroRequest || !!pendingSessionIntroPromise,
    deferredResumeKind: deferredResumeItem?.item?.kind || null,
    manualStartGraceSeconds: Math.max(0, Math.ceil((manualStartGraceUntil - now) / 1000)),
    manualStartGraceReason,
  };
}

function buildPodcastStatus() {
  const active = currentPodcastPlayback || podcastState.active || null;
  const currentEpisodeKey = active?.episodeKey || podcastState.currentEpisodeKey;
  const episodeState = currentEpisodeKey ? podcastState.episodes?.[currentEpisodeKey] : null;
  const lastSegmentIsCurrent = !!currentEpisodeKey && podcastState.lastSegment?.episodeKey === currentEpisodeKey;
  const hasCurrentPodcast = podcastSessionActive && !!episodeState;
  const isPlayingPodcast = currentItem?.kind === 'podcast' && playing;
  if (!hasCurrentPodcast && !isPlayingPodcast) {
    return {
      isPlaying: false,
      sessionActive: false,
      currentEpisodeKey: null,
      showTitle: null,
      episodeTitle: null,
      currentPositionSeconds: 0,
      durationSeconds: 0,
      part: 1,
      segmentStartSeconds: null,
      segmentEndSeconds: null,
      nextBreakTargetSeconds: null,
      breakReason: null,
      breakReasonDetail: null,
      adSkipStartSeconds: null,
      adSkipEndSeconds: null,
      hasTranscript: false,
      hasChapters: false,
      lastSegmentContextSource: null,
      willResume: false,
      breakSongsRemaining: 0,
      lastSegment: null,
    };
  }
  return {
    isPlaying: isPlayingPodcast,
    sessionActive: podcastSessionActive,
    currentEpisodeKey: currentEpisodeKey || null,
    showTitle: active?.showTitle || episodeState?.showTitle || null,
    episodeTitle: active?.episodeTitle || episodeState?.episodeTitle || null,
    currentPositionSeconds: active?.currentPositionSeconds ?? episodeState?.positionSeconds ?? 0,
    durationSeconds: active?.durationSeconds ?? episodeState?.durationSeconds ?? 0,
    part: active?.part ?? episodeState?.part ?? 1,
    segmentStartSeconds: active?.segmentStartSeconds ?? (lastSegmentIsCurrent ? podcastState.lastSegment?.startSeconds : null) ?? null,
    segmentEndSeconds: active?.segmentEndSeconds ?? (lastSegmentIsCurrent ? podcastState.lastSegment?.endSeconds : null) ?? null,
    nextBreakTargetSeconds: active?.segmentEndSeconds ?? null,
    breakReason: active?.breakReason || (lastSegmentIsCurrent ? podcastState.lastSegment?.breakReason : null) || null,
    breakReasonDetail: active?.breakReasonDetail || (lastSegmentIsCurrent ? podcastState.lastSegment?.breakReasonDetail : null) || null,
    adSkipStartSeconds: active?.adSkipStartSeconds || (lastSegmentIsCurrent ? podcastState.lastSegment?.adSkipStartSeconds : null) || null,
    adSkipEndSeconds: active?.adSkipEndSeconds || (lastSegmentIsCurrent ? podcastState.lastSegment?.adSkipEndSeconds : null) || null,
    hasTranscript: !!(active?.hasTranscript ?? episodeState?.transcriptUrl) || !!readCachedPodcastTranscript({ id: episodeState?.guid || currentEpisodeKey, audioUrl: episodeState?.episodeUrl, title: episodeState?.episodeTitle })?.text,
    hasChapters: !!(active?.hasChapters ?? (Array.isArray(episodeState?.chapters) && episodeState.chapters.length > 0)),
    lastSegmentContextSource: lastSegmentIsCurrent ? (podcastState.lastSegment?.contextSource || null) : null,
    willResume: hasCurrentPodcast && !!episodeState && !episodeState.completed,
    breakSongsRemaining: podcastBreakSongsRemaining,
    lastSegment: lastSegmentIsCurrent ? (podcastState.lastSegment || null) : null,
  };
}

// ── Wavlake charts ────────────────────────────────────────────────────────────

async function fetchCharts(attempt = 0) {
  try {
    const res = await fetch(CHARTS_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success || !Array.isArray(json.data)) throw new Error('unexpected shape');
    return json.data
      .filter(t => t.liveUrl && t.duration > 30 && t.duration <= 600)
      .map(t => ({
        kind: 'music',
        id: t.id,
        title: t.title,
        artist: t.artist,
        artworkUrl: t.artworkUrl || '',
        liveUrl: t.liveUrl,
        duration: t.duration,
      }));
  } catch(e) {
    if (attempt < 5) {
      const delay = (attempt + 1) * 5_000;
      console.warn(`[engine] chart fetch failed (${e.message}), retry in ${delay / 1000}s…`);
      await sleep(delay);
      return fetchCharts(attempt + 1);
    }
    throw e;
  }
}

function normalizeWavlakeTrack(t, source = 'wavlake') {
  const liveUrl = t.liveUrl || t.mediaUrl || t.audioUrl || '';
  const title = t.title || t.name || '';
  const duration = Number(t.duration || 0);
  if (!t.id || !liveUrl || !title || !t.artist || duration <= 20) return null;
  return {
    kind: 'music',
    id: t.id,
    title,
    artist: t.artist,
    artistId: t.artistId || '',
    albumTitle: t.albumTitle || '',
    albumId: t.albumId || '',
    artworkUrl: t.artworkUrl || t.albumArtUrl || t.avatarUrl || t.artistArtUrl || '',
    avatarUrl: t.avatarUrl || t.artistArtUrl || '',
    liveUrl,
    duration,
    source,
  };
}

async function fetchWavlakePlaylist(playlistId) {
  const id = String(playlistId || '').trim();
  if (!id) throw new Error('Missing Wavlake playlist ID');
  const res = await fetch(`${WAVLAKE_PLAYLIST_URL}/${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': 'PersonalRadio/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Wavlake playlist HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success || !json.data || !Array.isArray(json.data.tracks)) {
    throw new Error('unexpected Wavlake playlist shape');
  }
  const tracks = json.data.tracks
    .map(t => normalizeWavlakeTrack(t, 'wavlake-playlist'))
    .filter(Boolean);
  return {
    id,
    title: json.data.title || id,
    tracks,
  };
}

async function fetchLikedTracks() {
  const liked = await loadLiked();
  return liked
    .map(t => normalizeWavlakeTrack(t, 'pr-liked-songs'))
    .filter(Boolean);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function recentTrackCooldownMinutes() {
  const minutes = Number(engineSettings.recentTrackCooldownMinutes ?? 180);
  return Number.isFinite(minutes) && minutes > 0 ? Math.min(24 * 60, Math.max(5, minutes)) : 0;
}

function normalizeTrackTitle(value = '') {
  return String(value || '').trim().toLowerCase();
}

function trackMatchesMemoryRow(item, row = {}) {
  if (!item || !row) return false;
  const id = String(item.id || '').trim();
  const rowId = String(row.trackId || row.id || '').trim();
  const liveUrl = String(item.liveUrl || '').trim();
  const rowUrl = String(row.liveUrl || '').trim();
  if (id && rowId && id === rowId) return true;
  if (liveUrl && rowUrl && liveUrl === rowUrl) return true;
  return normalizeTrackTitle(item.title) === normalizeTrackTitle(row.title)
    && normalizeTrackTitle(item.artist) === normalizeTrackTitle(row.artist);
}

function recentlyPlayedHit(item, memory = loadMemory()) {
  if (!item || item.kind !== 'music') return null;
  const cooldownMs = recentTrackCooldownMinutes() * 60_000;
  if (cooldownMs <= 0) return null;
  const cutoff = Date.now() - cooldownMs;
  const recentRows = Array.isArray(memory.recentTracks) ? memory.recentTracks : [];
  for (const row of recentRows) {
    if (!trackMatchesMemoryRow(item, row)) continue;
    const ts = Date.parse(row.ts || row.lastPlayedAt || row.lastFinishedAt || '');
    if (Number.isFinite(ts) && ts >= cutoff) return { source: 'recentTracks', ts: row.ts || new Date(ts).toISOString() };
  }
  const stats = memory.trackStats && typeof memory.trackStats === 'object' ? Object.values(memory.trackStats) : [];
  for (const row of stats) {
    if (!trackMatchesMemoryRow(item, row)) continue;
    const ts = Math.max(
      Date.parse(row.lastPlayedAt || '') || 0,
      Date.parse(row.lastFinishedAt || '') || 0,
      Date.parse(row.lastSkippedAt || '') || 0
    );
    if (ts >= cutoff) return { source: 'trackStats', ts: new Date(ts).toISOString() };
  }
  return null;
}

function filterRecentlyPlayedTracks(tracks) {
  const playable = tracks.filter(t => !isBlocked(t));
  const memory = loadMemory();
  const fresh = [];
  const skipped = [];
  for (const track of playable) {
    const hit = recentlyPlayedHit(track, memory);
    if (hit) skipped.push({ track, hit });
    else fresh.push(track);
  }
  if (fresh.length > 0) {
    if (skipped.length > 0) {
      console.log(
        `[engine] recent-track cooldown filtered ${skipped.length} track(s) for ${recentTrackCooldownMinutes()} min; ${fresh.length} remain`
      );
    }
    return fresh;
  }
  if (skipped.length > 0) {
    console.warn('[engine] recent-track cooldown would empty queue; allowing repeats as fallback');
  }
  return playable;
}

function audioAnalysisWindowSeconds() {
  const seconds = Number(engineSettings.audioAnalysisWindowSeconds ?? 45);
  return Number.isFinite(seconds) && seconds > 5 ? Math.min(120, Math.max(15, seconds)) : 45;
}

function audioAnalysisKey(item) {
  const raw = [
    item?.id || '',
    item?.liveUrl || '',
    item?.artist || '',
    item?.title || '',
    Number(item?.duration || 0) || '',
  ].join('|');
  return createHash('sha1').update(raw).digest('hex');
}

function getAudioAnalysis(item) {
  const key = audioAnalysisKey(item);
  const row = audioAnalysisCache.tracks?.[key];
  if (!row || row.version !== AUDIO_ANALYSIS_VERSION) return null;
  return row;
}

function normalizeAnalysisTime(value, duration, windowSeconds) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  if (Number.isFinite(duration) && duration > 0 && n > Math.max(windowSeconds + 5, duration - windowSeconds - 2)) {
    return Math.min(duration, n);
  }
  const base = Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - windowSeconds) : 0;
  return base + n;
}

function parseSilenceStart(text, duration, windowSeconds) {
  const matches = [...String(text || '').matchAll(/silence_start:\s*([0-9.]+)/g)]
    .map(m => normalizeAnalysisTime(Number(m[1]), duration, windowSeconds))
    .filter(n => Number.isFinite(n));
  return matches.length ? Math.min(...matches) : null;
}

function parseInitialSilenceEnd(text) {
  const raw = String(text || '');
  const start = raw.match(/silence_start:\s*0(?:\.0+)?/);
  if (!start) return 0;
  const after = raw.slice(start.index || 0);
  const end = after.match(/silence_end:\s*([0-9.]+)/);
  const seconds = end ? Number(end[1]) : 0;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function introSkipMaxSeconds() {
  const seconds = Number(engineSettings.transitionIntroSkipMaxSeconds ?? 8);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(20, Math.max(0, seconds)) : 0;
}

function parseRmsPoints(text, duration, windowSeconds) {
  const lines = String(text || '').split(/\r?\n/);
  const points = [];
  let currentTime = null;
  for (const line of lines) {
    const timeMatch = line.match(/pts_time:([0-9.]+)/);
    if (timeMatch) currentTime = normalizeAnalysisTime(Number(timeMatch[1]), duration, windowSeconds);
    const rmsMatch = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?(?:inf|[0-9.]+))/i);
    if (rmsMatch && Number.isFinite(currentTime)) {
      const rms = /^-?inf$/i.test(rmsMatch[1]) ? -120 : Number(rmsMatch[1]);
      if (Number.isFinite(rms)) points.push({ time: currentTime, rms });
    }
  }
  return points;
}

function detectFadeStart(points, duration) {
  if (!points.length || !Number.isFinite(duration) || duration <= 0) return null;
  const usable = points.filter(p => Number.isFinite(p.rms) && p.rms > -90);
  if (usable.length < 6) return null;
  const loud = usable
    .slice(0, Math.max(3, Math.floor(usable.length * 0.45)))
    .map(p => p.rms)
    .sort((a, b) => b - a);
  const reference = loud[Math.floor(Math.min(loud.length - 1, loud.length * 0.35))] ?? -24;
  const threshold = Math.min(-32, reference - 10);
  const tailLow = [];
  for (let i = usable.length - 1; i >= 0; i--) {
    if (usable[i].rms <= threshold) tailLow.unshift(usable[i]);
    else if (tailLow.length >= 3) break;
    else tailLow.length = 0;
  }
  if (tailLow.length >= 3) return tailLow[0].time;

  const last = usable[usable.length - 1];
  if (last.rms <= reference - 14) {
    const candidate = usable.find(p => p.time >= duration - 18 && p.rms <= reference - 8);
    if (candidate) return candidate.time;
  }
  return null;
}

function buildOutroRecommendation({ item, silenceStartSeconds, fadeStartSeconds }) {
  const duration = Number(item?.duration || 0);
  const fade = crossfadeSeconds();
  if (!Number.isFinite(duration) || duration <= fade + 8) return null;
  const fallback = Math.max(0, duration - fade);
  let recommended = fallback;
  let reason = 'duration';
  if (Number.isFinite(silenceStartSeconds)) {
    recommended = Math.min(recommended, Math.max(0, silenceStartSeconds - Math.min(fade, 3)));
    reason = 'silence';
  }
  if (Number.isFinite(fadeStartSeconds)) {
    const fadeCandidate = Math.max(duration - 14, Math.min(duration - fade, fadeStartSeconds + 2));
    if (fadeCandidate < recommended) {
      recommended = fadeCandidate;
      reason = 'fade';
    }
  }
  recommended = Math.max(duration - 16, Math.min(duration - 1.5, recommended));
  return {
    transitionStartSeconds: recommended,
    reason,
  };
}

async function analyzeTrackOutro(item, sourceUrl = item?.liveUrl) {
  if (engineSettings.audioAnalysisEnabled === false) return null;
  if (!sourceUrl || item?.kind !== 'music') return null;
  // Remote HTTP seeking is often slow or unsupported. The production music path
  // caches tracks locally before playback, so analyse that local file instead.
  if (/^https?:\/\//i.test(sourceUrl) && CACHE_HTTP_AUDIO) return null;
  const key = audioAnalysisKey(item);
  const cached = getAudioAnalysis(item);
  if (cached) return cached;
  if (audioAnalysisInFlight.has(key)) return audioAnalysisInFlight.get(key);

  const promise = (async () => {
    const duration = Number(item.duration || 0);
    if (!Number.isFinite(duration) || duration < 30) return null;
    const windowSeconds = Math.min(audioAnalysisWindowSeconds(), Math.max(15, duration - 1));
    const input = sourceUrl;
    try {
      let audibleStartSeconds = 0;
      let introSilenceEndSeconds = null;
      if (engineSettings.transitionIntroAnalysisEnabled !== false && introSkipMaxSeconds() > 0) {
        const introWindowSeconds = Math.min(30, Math.max(8, duration - 1));
        const intro = await runCommand('ffmpeg', [
          '-hide_banner',
          '-nostdin',
          '-t', String(Math.round(introWindowSeconds)),
          '-i', input,
          '-vn',
          '-af', 'silencedetect=n=-45dB:d=0.15',
          '-f', 'null',
          '-',
        ], 15_000);
        const introText = `${intro.stdout || ''}\n${intro.stderr || ''}`;
        introSilenceEndSeconds = parseInitialSilenceEnd(introText);
        if (Number.isFinite(introSilenceEndSeconds) && introSilenceEndSeconds > 0) {
          audibleStartSeconds = Math.min(introSkipMaxSeconds(), Math.max(0, introSilenceEndSeconds - 0.05));
        }
      }

      const silence = await runCommand('ffmpeg', [
        '-hide_banner',
        '-nostdin',
        '-sseof', `-${Math.round(windowSeconds)}`,
        '-i', input,
        '-vn',
        '-af', 'silencedetect=n=-42dB:d=0.8',
        '-f', 'null',
        '-',
      ], 18_000);
      const silenceText = `${silence.stdout || ''}\n${silence.stderr || ''}`;
      const silenceStartSeconds = parseSilenceStart(silenceText, duration, windowSeconds);

      const rms = await runCommand('ffmpeg', [
        '-hide_banner',
        '-nostdin',
        '-sseof', `-${Math.round(windowSeconds)}`,
        '-i', input,
        '-vn',
        '-af', 'aresample=8000,asetnsamples=n=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
        '-f', 'null',
        '-',
      ], 22_000);
      if (!silence.ok && !rms.ok) {
        throw new Error(`ffmpeg analysis failed: ${(rms.stderr || silence.stderr || '').slice(0, 240)}`);
      }
      const rmsText = `${rms.stdout || ''}\n${rms.stderr || ''}`;
      const rmsPoints = parseRmsPoints(rmsText, duration, windowSeconds);
      const fadeStartSeconds = detectFadeStart(rmsPoints, duration);
      const recommendation = buildOutroRecommendation({ item, silenceStartSeconds, fadeStartSeconds });
      const row = {
        version: AUDIO_ANALYSIS_VERSION,
        key,
        trackId: item.id || '',
        title: item.title || '',
        artist: item.artist || '',
        durationSeconds: duration,
        windowSeconds,
        silenceStartSeconds,
        fadeStartSeconds,
        transitionStartSeconds: recommendation?.transitionStartSeconds ?? Math.max(0, duration - crossfadeSeconds()),
        transitionReason: recommendation?.reason || 'duration',
        introSilenceEndSeconds,
        audibleStartSeconds,
        analyzedAt: new Date().toISOString(),
      };
      audioAnalysisCache.tracks[key] = row;
      saveAudioAnalysisCache();
      console.log(`[engine] audio analysis cached: ${item.artist} — ${item.title} transition=${Math.round(row.transitionStartSeconds)}s reason=${row.transitionReason} audibleStart=${Number(row.audibleStartSeconds || 0).toFixed(2)}s`);
      return row;
    } catch (err) {
      console.warn(`[engine] audio analysis failed for ${item.artist} — ${item.title}: ${err.message}`);
      return null;
    } finally {
      audioAnalysisInFlight.delete(key);
    }
  })();
  audioAnalysisInFlight.set(key, promise);
  return promise;
}

function prefetchAudioAnalysis(items = []) {
  if (engineSettings.audioAnalysisEnabled === false) return;
  const limit = Number.isFinite(AUDIO_ANALYSIS_PREFETCH_LIMIT) && AUDIO_ANALYSIS_PREFETCH_LIMIT > 0 ? AUDIO_ANALYSIS_PREFETCH_LIMIT : 4;
  for (const item of items.filter(t => t?.kind === 'music').slice(0, limit)) {
    if (!getAudioAnalysis(item) && item.liveUrl && !/^https?:\/\//i.test(item.liveUrl)) {
      analyzeTrackOutro(item).catch(() => {});
    }
  }
}

async function refillQueue() {
  let tracks;
  try {
    if (engineSettings.musicSource === 'wavlakePlaylist' && normalizeWavlakePlaylists().length > 0) {
      const configuredPlaylists = normalizeWavlakePlaylists();
      const playlistResults = await Promise.allSettled(configuredPlaylists.map(row => fetchWavlakePlaylist(row.id)));
      const playlists = playlistResults
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);
      const errors = playlistResults
        .filter(result => result.status === 'rejected')
        .map(result => result.reason?.message || String(result.reason));
      if (playlists.length === 0) throw new Error(`No Wavlake playlist could be loaded${errors.length ? ` (${errors.join('; ')})` : ''}`);
      engineSettings = {
        ...engineSettings,
        wavlakePlaylistId: playlists[0].id,
        wavlakePlaylistTitle: playlists[0].title,
        wavlakePlaylists: playlists.map(p => ({ id: p.id, title: p.title })),
      };
      saveSettings(engineSettings);
      tracks = playlists.flatMap(playlist => playlist.tracks.map(track => ({
        ...track,
        sourcePlaylistId: playlist.id,
        sourcePlaylistTitle: playlist.title,
      })));
      console.log(`[engine] queue refilled from ${playlists.length} Wavlake playlist(s): ${tracks.length} tracks${errors.length ? `, ${errors.length} failed` : ''}`);
    } else if (engineSettings.musicSource === 'prLikedSongs') {
      tracks = await fetchLikedTracks();
      console.log(`[engine] queue refilled from PR Liked Songs: ${tracks.length} tracks`);
      if (tracks.length === 0) {
        console.warn('[engine] PR Liked Songs has no playable tracks, falling back to Top Charts');
        tracks = await fetchCharts();
      }
    } else {
      tracks = await fetchCharts();
      console.log(`[engine] queue refilled from Wavlake Top Charts: ${tracks.length} tracks`);
    }
  }
  catch(e) { console.error('[engine] music source fetch failed permanently:', e.message); return false; }
  queue = shuffle(filterRecentlyPlayedTracks(tracks));
  console.log(`[engine] queue ready: ${queue.length} music tracks`);
  prefetchAudioAnalysis(queue);
  return queue.length > 0;
}

// ── Podcast ───────────────────────────────────────────────────────────────────

function decodeXml(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim();
}

function stripHtml(s = '') {
  return decodeXml(String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}

function parseDurationSecs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  const raw = String(value || '').trim();
  if (!raw) return 0;
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const parts = raw.split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function getPodcastTranscriptUrl(itemXml = '') {
  const candidates = [...itemXml.matchAll(/<podcast:transcript\b[^>]*>/gi)]
    .map(m => m[0])
    .map(tag => ({
      url: decodeXml(tag.match(/\burl=["']([^"']+)["']/i)?.[1] || ''),
      type: (tag.match(/\btype=["']([^"']+)["']/i)?.[1] || '').toLowerCase(),
    }))
    .filter(t => t.url);
  if (!candidates.length) return '';
  return (
    candidates.find(t => /json|srt|vtt|text|plain/.test(t.type)) ||
    candidates[0]
  ).url;
}

async function fetchLatestPodcastEpisode() {
  const feedUrl = engineSettings.podcastFeedUrl || PODCAST_URL;
  const res = await fetch(feedUrl, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`podcast feed HTTP ${res.status}`);
  const xml  = await res.text();
  const item = xml.match(/<item\b[\s\S]*?<\/item>/i)?.[0];
  if (!item) throw new Error('podcast feed: no item');
  const enclosure = item.match(/<enclosure\b[^>]*url=["']([^"']+)["'][^>]*>/i)?.[1]
    || item.match(/<media:content\b[^>]*url=["']([^"']+)["'][^>]*>/i)?.[1];
  if (!enclosure) throw new Error('podcast feed: no enclosure URL');
  const title     = decodeXml(item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Podcast');
  const feedTitle = decodeXml(xml.match(/<channel[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Podcast');
  const description = stripHtml(
    item.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] ||
    item.match(/<itunes:summary[^>]*>([\s\S]*?)<\/itunes:summary>/i)?.[1] ||
    ''
  );
  const duration = parseDurationSecs(item.match(/<itunes:duration[^>]*>([\s\S]*?)<\/itunes:duration>/i)?.[1] || 0);
  const transcriptUrl = getPodcastTranscriptUrl(item);
  return {
    kind: 'podcast',
    id: decodeXml(enclosure),
    title,
    artist: feedTitle,
    artworkUrl: '',
    liveUrl: decodeXml(enclosure),
    duration,
    episode: {
      id: decodeXml(enclosure),
      feedTitle,
      title,
      audioUrl: decodeXml(enclosure),
      duration,
      description,
      transcriptUrl,
      pubDate: decodeXml(item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] || ''),
    },
  };
}

function parsePodcastItemsFromXml(xml, feedUrl, maxItems = 5) {
  const feedTitle = decodeXml(xml.match(/<channel[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Podcast');
  const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(match => match[0]);
  return items.slice(0, maxItems).map(item => {
    const enclosure = item.match(/<enclosure\b[^>]*url=["']([^"']+)["'][^>]*>/i)?.[1]
      || item.match(/<media:content\b[^>]*url=["']([^"']+)["'][^>]*>/i)?.[1]
      || '';
    const audioUrl = decodeXml(enclosure);
    if (!audioUrl) return null;
    const title = decodeXml(item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Podcast');
    const description = stripHtml(
      item.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] ||
      item.match(/<itunes:summary[^>]*>([\s\S]*?)<\/itunes:summary>/i)?.[1] ||
      ''
    );
    const pubDate = decodeXml(item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] || '');
    const guid = decodeXml(item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1] || '');
    return {
      id: guid || audioUrl,
      feedUrl,
      feedTitle,
      title,
      audioUrl,
      duration: parseDurationSecs(item.match(/<itunes:duration[^>]*>([\s\S]*?)<\/itunes:duration>/i)?.[1] || 0),
      description,
      author: decodeXml(item.match(/<itunes:author[^>]*>([\s\S]*?)<\/itunes:author>/i)?.[1] || ''),
      pubDate,
      transcriptUrl: getPodcastTranscriptUrl(item) || undefined,
    };
  }).filter(Boolean);
}

function roundRobinPodcastQueue(perFeed, maxTotal = 5) {
  if (perFeed.length === 0) return [];
  if (perFeed.length === 1) return perFeed[0].slice(0, maxTotal);
  const capped = perFeed.map(episodes => episodes.slice(0, 2));
  const cursors = new Array(capped.length).fill(0);
  const result = [];
  let remaining = capped.reduce((sum, episodes) => sum + episodes.length, 0);
  while (remaining > 0 && result.length < maxTotal) {
    for (let i = 0; i < capped.length; i++) {
      if (result.length >= maxTotal) break;
      if (cursors[i] < capped[i].length) {
        result.push(capped[i][cursors[i]++]);
        remaining--;
      }
    }
  }
  return result;
}

async function refreshPodcastQueueFromFeeds() {
  const configuredFeeds = Array.isArray(engineSettings.podcastFeeds) ? engineSettings.podcastFeeds : [];
  const feeds = configuredFeeds.length > 0
    ? configuredFeeds
    : (engineSettings.podcastFeedUrl ? [{ url: engineSettings.podcastFeedUrl, title: 'Podcast' }] : []);
  const uniqueFeeds = [...new Map(feeds.filter(f => f?.url).map(f => [f.url, f])).values()];
  if (uniqueFeeds.length === 0) throw new Error('No podcast feeds configured');

  const results = await Promise.allSettled(uniqueFeeds.map(async feed => {
    const res = await fetch(feed.url, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${feed.title || feed.url}: HTTP ${res.status}`);
    const xml = await res.text();
    const episodes = parsePodcastItemsFromXml(xml, feed.url, uniqueFeeds.length === 1 ? 12 : 5);
    console.log(`[engine] podcast refresh: ${feed.title || feed.url} -> ${episodes.length} episodes`);
    return episodes;
  }));

  const perFeed = [];
  const errors = [];
  for (const result of results) {
    if (result.status === 'fulfilled') perFeed.push(result.value);
    else errors.push(result.reason?.message || String(result.reason));
  }
  const queue = roundRobinPodcastQueue(perFeed, 5).filter(ep => ep.audioUrl);
  if (queue.length === 0) throw new Error(`Podcast refresh yielded no playable episodes${errors.length ? ` (${errors.join('; ')})` : ''}`);

  engineSettings = {
    ...engineSettings,
    podcastFeeds: uniqueFeeds,
    podcastFeedUrl: uniqueFeeds[0]?.url || engineSettings.podcastFeedUrl,
    podcastQueue: queue,
    podcastQueueRefreshedAt: new Date().toISOString(),
  };
  saveSettings(engineSettings);
  console.log(`[engine] podcast queue refreshed: ${queue.length} episodes from ${uniqueFeeds.length} feed(s)${errors.length ? `, ${errors.length} failed` : ''}`);
  prefetchPodcastTranscripts(queue, 'queue-refresh');
  return { queue, feeds: uniqueFeeds, errors, refreshedAt: engineSettings.podcastQueueRefreshedAt };
}

function podcastEpisodeToItem(episode) {
  return {
    kind: 'podcast',
    id: episode.id || episode.audioUrl || episode.liveUrl,
    title: episode.title || 'Podcast',
    artist: episode.feedTitle || episode.artist || 'Podcast',
    artworkUrl: episode.artworkUrl || '',
    liveUrl: episode.audioUrl || episode.liveUrl,
    duration: Number(episode.duration || 0),
    episode,
  };
}

function shiftQueuedPodcastEpisode() {
  const queued = Array.isArray(engineSettings.podcastQueue) ? [...engineSettings.podcastQueue] : [];
  while (queued.length > 0) {
    const episode = queued.shift();
    engineSettings = { ...engineSettings, podcastQueue: queued };
    saveSettings(engineSettings);
    if (episode?.audioUrl || episode?.liveUrl) {
      prefetchPodcastTranscripts(queued, 'queue-shift');
      return podcastEpisodeToItem(episode);
    }
  }
  return null;
}

function currentPodcastResumeItem() {
  const key = podcastState.currentEpisodeKey;
  const state = key ? podcastState.episodes?.[key] : null;
  if (!key || !state || state.completed || !state.episodeUrl) return null;
  if (Number(state.positionSeconds || 0) <= 0) return null;
  return {
    kind: 'podcast',
    id: state.guid || key,
    title: state.episodeTitle || 'Podcast',
    artist: state.showTitle || 'Podcast',
    artworkUrl: '',
    liveUrl: state.episodeUrl,
    duration: Number(state.durationSeconds || 0),
    episode: {
      id: state.guid || key,
      feedUrl: state.feedUrl || '',
      feedTitle: state.showTitle || 'Podcast',
      title: state.episodeTitle || 'Podcast',
      audioUrl: state.episodeUrl,
      duration: Number(state.durationSeconds || 0),
      description: state.description || '',
      transcriptUrl: state.transcriptUrl || undefined,
      chapters: Array.isArray(state.chapters) ? state.chapters : [],
    },
  };
}

async function nextPodcastEpisode() {
  const resume = currentPodcastResumeItem();
  if (resume) {
    const state = podcastState.episodes?.[podcastState.currentEpisodeKey] || {};
    console.log(`[engine] podcast resume selected from state: ${resume.artist} — ${resume.title} @ ${Math.round(Number(state.positionSeconds || 0))}s`);
    return resume;
  }
  const queued = shiftQueuedPodcastEpisode();
  if (queued) return queued;
  return fetchLatestPodcastEpisode();
}

function podcastEpisodeKey(item) {
  return item.episode?.id || item.id || item.liveUrl;
}

function getEpisodeState(item) {
  const episodeKey = podcastEpisodeKey(item);
  const existing = podcastState.episodes?.[episodeKey] || {};
  const episode = item.episode || {};
  const next = {
    feedUrl: episode.feedUrl || engineSettings.podcastFeedUrl || '',
    episodeUrl: item.liveUrl,
    originalEpisodeUrl: existing.originalEpisodeUrl || episode.audioUrl || item.liveUrl,
    resolvedEpisodeUrl: existing.resolvedEpisodeUrl || '',
    resolvedEpisodeUrlAt: existing.resolvedEpisodeUrlAt || '',
    guid: episode.id || item.id || item.liveUrl,
    showTitle: episode.feedTitle || item.artist || 'Podcast',
    episodeTitle: episode.title || item.title || 'Podcast',
    positionSeconds: Math.max(0, Number(existing.positionSeconds || 0)),
    durationSeconds: Math.max(Number(existing.durationSeconds || 0), Number(episode.duration || item.duration || 0)),
    part: Math.max(1, Number(existing.part || 1)),
    completed: !!existing.completed,
    transcriptUrl: episode.transcriptUrl || existing.transcriptUrl || '',
    chapters: Array.isArray(episode.chapters) ? episode.chapters : (Array.isArray(existing.chapters) ? existing.chapters : []),
    description: episode.description || existing.description || '',
    lastSegmentStart: Number(existing.lastSegmentStart || 0),
    lastSegmentEnd: Number(existing.lastSegmentEnd || 0),
    lastContextSource: existing.lastContextSource || null,
  };
  podcastState.episodes[episodeKey] = next;
  podcastState.currentEpisodeKey = episodeKey;
  return { episodeKey, state: next };
}

async function resolvePodcastAudioUrl(item, episodeState) {
  const originalUrl = episodeState.originalEpisodeUrl || episodeState.episodeUrl || item.liveUrl;
  const resolvedAtMs = episodeState.resolvedEpisodeUrlAt ? Date.parse(episodeState.resolvedEpisodeUrlAt) : 0;
  if (episodeState.resolvedEpisodeUrl
      && resolvedAtMs
      && Date.now() - resolvedAtMs < PODCAST_RESOLVED_URL_TTL_MS) {
    return episodeState.resolvedEpisodeUrl;
  }

  try {
    const res = await fetch(`${PODCAST_AUDIO_RESOLVER_URL}&url=${encodeURIComponent(originalUrl)}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`audioresolver HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const finalUrl = String(await res.text()).trim();
    if (!/^https?:\/\//i.test(finalUrl)) throw new Error('audioresolver returned invalid URL');
    episodeState.resolvedEpisodeUrl = finalUrl;
    episodeState.resolvedEpisodeUrlAt = new Date().toISOString();
    console.log(`[engine] resolved podcast audio URL for "${episodeState.episodeTitle}": ${new URL(finalUrl).host}`);
    return finalUrl;
  } catch (err) {
    console.warn(`[engine] podcast audio URL resolve failed for "${episodeState.episodeTitle}": ${err.message}`);
    return originalUrl;
  }
}

async function buildPodcastSegmentPlaybackFile(segment, resolvedUrl) {
  if (!PODCAST_SEGMENT_CACHE_ENABLED) return null;
  mkdirSync(TMP_DIR, { recursive: true });
  const tmpFile = path.join(TMP_DIR, `podcast-segment-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
  const result = await runCommand('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(Math.max(0, Math.floor(segment.startSeconds))),
    '-t', String(Math.max(1, Math.ceil(segment.durationSeconds))),
    '-i', resolvedUrl,
    '-vn',
    '-codec:a', 'libmp3lame',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-y',
    tmpFile,
  ], Math.ceil((segment.durationSeconds + 180) * 1000));

  if (!result.ok) {
    try { unlinkSync(tmpFile); } catch {}
    throw new Error(result.stderr || 'ffmpeg segment extract failed');
  }
  const duration = await probeAudioDurationSeconds(tmpFile);
  if (!duration || duration < Math.min(5, segment.durationSeconds * 0.5)) {
    try { unlinkSync(tmpFile); } catch {}
    throw new Error(`segment extract duration invalid (${duration || 0}s)`);
  }
  console.log(`[engine] cached podcast segment for stable playback: ${tmpFile} (${duration.toFixed(1)}s)`);
  return tmpFile;
}

function normalizePodcastSegmentSettings() {
  const minMinutes = Number(engineSettings.podcastSegmentMinMinutes ?? DEFAULT_SETTINGS.podcastSegmentMinMinutes);
  const maxMinutes = Number(engineSettings.podcastSegmentMaxMinutes ?? DEFAULT_SETTINGS.podcastSegmentMaxMinutes);
  const minSeconds = Math.max(1, (Number.isFinite(minMinutes) ? minMinutes : 8) * 60);
  const maxSeconds = Math.max(minSeconds, (Number.isFinite(maxMinutes) ? maxMinutes : 15) * 60);
  return { minSeconds, maxSeconds };
}

function parseTimeSecs(ts = '') {
  const clean = String(ts).replace(',', '.').replace(/\s+.*$/, '');
  const parts = clean.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(clean) || 0;
}

function parseCueEntries(raw = '') {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      if (Array.isArray(data.words) && data.words.length > 0) {
        const entries = [];
        let current = null;
        for (const word of data.words) {
          const start = Number(word.start ?? 0) / (Number(word.start ?? 0) > 10_000 ? 1000 : 1);
          const end = Number(word.end ?? word.start ?? 0) / (Number(word.end ?? word.start ?? 0) > 10_000 ? 1000 : 1);
          const text = String(word.text || word.word || '').trim();
          if (!text) continue;
          if (!current) current = { start, end, text };
          else {
            current.end = end;
            current.text += `${/^[,.;:!?]/.test(text) ? '' : ' '}${text}`;
          }
          if (/[.!?…]$/.test(text) || current.end - current.start >= 20) {
            entries.push(current);
            current = null;
          }
        }
        if (current) entries.push(current);
        return entries;
      }
      const segs = Array.isArray(data.segments) ? data.segments : [];
      return segs
        .map(s => ({
          start: Number(s.startTime ?? s.start ?? 0),
          end: Number(s.endTime ?? s.end ?? s.startTime ?? s.start ?? 0),
          text: String(s.body ?? s.text ?? '').trim(),
        }))
        .filter(e => e.text);
    } catch {}
  }
  if (!trimmed.includes('-->')) return [];
  const entries = [];
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line.includes('-->')) { i++; continue; }
    const [startStr, endStr] = line.split('-->').map(s => s.trim());
    const start = parseTimeSecs(startStr);
    const end = parseTimeSecs(endStr);
    const textLines = [];
    i++;
    while (i < lines.length && lines[i].trim() !== '') {
      const l = lines[i].trim();
      if (l && !/^\d+$/.test(l) && !l.startsWith('NOTE')) textLines.push(l);
      i++;
    }
    const text = textLines.join(' ').trim();
    if (text) entries.push({ start, end, text });
  }
  return entries;
}

function extractTranscriptWindow(raw = '', fromSecs, toSecs) {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{') || trimmed.includes('-->')) {
    const entries = parseCueEntries(raw);
    const text = entries
      .filter(e => e.end >= fromSecs && e.start <= toSecs)
      .map(e => e.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text;
  }
  return '';
}

function plainTranscriptText(raw = '') {
  const trimmed = String(raw || '').trimStart();
  if (!trimmed) return '';
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      return String(data.text || '')
        || (Array.isArray(data.words) ? data.words.map(w => w.text || w.word || '').join(' ') : '')
        || (Array.isArray(data.segments) ? data.segments.map(s => s.text || s.body || '').join(' ') : '');
    } catch {}
  }
  if (trimmed.includes('-->')) {
    return parseCueEntries(trimmed).map(e => e.text).join(' ');
  }
  return trimmed;
}

const transcriptCache = new Map();

function podcastTranscriptCacheKey(episodeOrItem) {
  const episode = episodeOrItem?.episode || episodeOrItem || {};
  const seed = [
    episode.id,
    episode.guid,
    episode.audioUrl,
    episode.liveUrl,
    episode.episodeUrl,
    episode.title,
  ].filter(Boolean).join('|');
  return createHash('sha1').update(seed || JSON.stringify(episode)).digest('hex');
}

function podcastTranscriptCacheFile(episodeOrItem) {
  return path.join(PODCAST_TRANSCRIPT_DIR, `${podcastTranscriptCacheKey(episodeOrItem)}.json`);
}

function readCachedPodcastTranscript(episodeOrItem) {
  try {
    const file = podcastTranscriptCacheFile(episodeOrItem);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedPodcastTranscript(episodeOrItem, data) {
  mkdirSync(PODCAST_TRANSCRIPT_DIR, { recursive: true });
  const file = podcastTranscriptCacheFile(episodeOrItem);
  writeFileSync(file, JSON.stringify({
    ...data,
    cacheKey: podcastTranscriptCacheKey(episodeOrItem),
    savedAt: new Date().toISOString(),
  }, null, 2));
  return file;
}

function transcriptRecordToRaw(record) {
  if (!record) return '';
  if (Array.isArray(record.words) && record.words.length > 0) {
    return JSON.stringify({
      provider: record.provider || 'cached',
      text: record.text || '',
      words: record.words,
    });
  }
  return String(record.raw || record.text || '');
}

const activeTranscriptPrefetches = new Set();

async function summarizeTranscriptForIntro(episode, record) {
  if (!record) return '';
  if (record.introSummary) return String(record.introSummary);
  const text = plainTranscriptText(transcriptRecordToRaw(record)).replace(/\s+/g, ' ').trim();
  if (text.length < 200) return '';
  const sample = [
    text.slice(0, 1800),
    text.length > 3600 ? text.slice(Math.max(0, Math.floor(text.length / 2) - 900), Math.floor(text.length / 2) + 900) : '',
    text.length > 2200 ? text.slice(-1200) : '',
  ].filter(Boolean).join('\n...\n');
  try {
    const res = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        purpose: 'radio-moderation',
        system: 'Fasse einen Podcast fuer eine sehr kurze Radio-Anmoderation zusammen. Sachlich, konkret, nicht werblich. Antworte nur mit der Zusammenfassung.',
        messages: [{
          role: 'user',
          content: [
            `Podcast: ${episode.feedTitle || ''} — ${episode.title || ''}`,
            'Erstelle eine konkrete Zusammenfassung in 1-2 Saetzen.',
            sample,
          ].filter(Boolean).join('\n\n'),
        }],
      }),
      signal: AbortSignal.timeout(110_000),
    });
    if (!res.ok) throw new Error(`claude-proxy HTTP ${res.status}`);
    const json = await res.json();
    const summary = String(json?.content?.[0]?.text || '').trim();
    if (!summary) return '';
    writeCachedPodcastTranscript(episode, { ...record, introSummary: summary });
    return summary;
  } catch (err) {
    console.warn(`[engine] podcast transcript intro summary failed for "${episode.title}": ${err.message}`);
    return '';
  }
}

async function getPodcastIntroContextText(item, episodeState) {
  const description = String(episodeState.description || '').replace(/\s+/g, ' ').trim();
  if (description.length >= 80) return { source: 'description', text: description.slice(0, 900) };
  const episode = item.episode || {
    id: episodeState.guid || item.id,
    feedTitle: episodeState.showTitle,
    title: episodeState.episodeTitle,
    audioUrl: episodeState.episodeUrl || item.liveUrl,
    transcriptUrl: episodeState.transcriptUrl,
  };
  const record = readCachedPodcastTranscript(episode);
  if (record?.status !== 'completed') return { source: 'none', text: '' };
  const summary = await summarizeTranscriptForIntro(episode, record);
  return summary ? { source: 'transcriptSummary', text: summary } : { source: 'none', text: '' };
}

async function submitAssemblyAiTranscript(episode) {
  if (!ASSEMBLYAI_API_KEY) throw new Error('ASSEMBLYAI_API_KEY missing');
  const audioUrl = episode.audioUrl || episode.liveUrl;
  if (!audioUrl) throw new Error('episode has no audio URL');
  const res = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      authorization: ASSEMBLYAI_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      language_detection: true,
      punctuate: true,
      format_text: true,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`AssemblyAI submit HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function pollAssemblyAiTranscript(transcriptId, timeoutMs = 30 * 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(transcriptId)}`, {
      headers: { authorization: ASSEMBLYAI_API_KEY },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`AssemblyAI poll HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const json = await res.json();
    if (json.status === 'completed') return json;
    if (json.status === 'error') throw new Error(json.error || 'AssemblyAI transcript failed');
    await sleep(20_000);
  }
  throw new Error('AssemblyAI transcript timed out');
}

async function ensurePodcastTranscriptCached(episode, options = {}) {
  if (!episode?.audioUrl && !episode?.liveUrl) return null;
  const existing = readCachedPodcastTranscript(episode);
  if (existing?.status === 'completed' && (existing.text || existing.raw || existing.words?.length)) return existing;
  if (existing?.status === 'processing' && !options.resumeProcessing) return existing;

  if (episode.transcriptUrl) {
    const raw = await fetchTranscriptRaw(episode.transcriptUrl);
    const file = writeCachedPodcastTranscript(episode, {
      provider: 'feed',
      status: 'completed',
      feedTitle: episode.feedTitle || '',
      episodeTitle: episode.title || '',
      audioUrl: episode.audioUrl || episode.liveUrl,
      transcriptUrl: episode.transcriptUrl,
      raw,
      text: raw.replace(/\s+/g, ' ').trim(),
    });
    console.log(`[engine] cached feed transcript for "${episode.title}" -> ${file}`);
    return readCachedPodcastTranscript(episode);
  }

  if (!ASSEMBLYAI_API_KEY) {
    console.warn(`[engine] podcast transcript cache skipped for "${episode.title}": ASSEMBLYAI_API_KEY missing`);
    return null;
  }

  const submitted = existing?.assemblyTranscriptId
    ? { id: existing.assemblyTranscriptId }
    : await submitAssemblyAiTranscript(episode);
  writeCachedPodcastTranscript(episode, {
    provider: 'assemblyai',
    status: 'processing',
    assemblyTranscriptId: submitted.id,
    feedTitle: episode.feedTitle || '',
    episodeTitle: episode.title || '',
    audioUrl: episode.audioUrl || episode.liveUrl,
  });
  console.log(`[engine] AssemblyAI transcript queued for "${episode.title}": ${submitted.id}`);
  const completed = await pollAssemblyAiTranscript(submitted.id);
  const file = writeCachedPodcastTranscript(episode, {
    provider: 'assemblyai',
    status: 'completed',
    assemblyTranscriptId: completed.id,
    feedTitle: episode.feedTitle || '',
    episodeTitle: episode.title || '',
    audioUrl: episode.audioUrl || episode.liveUrl,
    languageCode: completed.language_code || '',
    text: completed.text || '',
    words: Array.isArray(completed.words) ? completed.words : [],
  });
  console.log(`[engine] AssemblyAI transcript cached for "${episode.title}" -> ${file}`);
  return readCachedPodcastTranscript(episode);
}

function prefetchPodcastTranscripts(episodes, reason = 'queue-refresh') {
  if (engineSettings.podcastTranscriptPrefetchEnabled === false) return;
  const limit = Math.max(0, Number(engineSettings.podcastTranscriptPrefetchLimit ?? 5));
  const selected = (Array.isArray(episodes) ? episodes : []).filter(Boolean).slice(0, limit);
  for (const episode of selected) {
    const key = podcastTranscriptCacheKey(episode);
    const existing = readCachedPodcastTranscript(episode);
    if (existing?.status === 'completed') continue;
    if (activeTranscriptPrefetches.has(key)) continue;
    activeTranscriptPrefetches.add(key);
    ensurePodcastTranscriptCached(episode, { resumeProcessing: true })
      .catch(err => console.warn(`[engine] podcast transcript prefetch failed (${reason}) for "${episode.title}": ${err.message}`))
      .finally(() => activeTranscriptPrefetches.delete(key));
  }
}

async function fetchTranscriptRaw(transcriptUrl) {
  if (!transcriptUrl) return '';
  if (transcriptCache.has(transcriptUrl)) return transcriptCache.get(transcriptUrl);
  const res = await fetch(`${PODCAST_TEXT_URL}&url=${encodeURIComponent(transcriptUrl)}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`transcript HTTP ${res.status}`);
  const text = await res.text();
  transcriptCache.set(transcriptUrl, text);
  return text;
}

function findChapterCut(chapters, startSeconds, minSeconds, maxSeconds) {
  if (!Array.isArray(chapters) || chapters.length === 0) return null;
  const minTarget = startSeconds + minSeconds;
  const maxTarget = startSeconds + maxSeconds;
  const sorted = chapters
    .map(ch => ({ ...ch, startTime: Number(ch.startTime ?? ch.start ?? 0) }))
    .filter(ch => Number.isFinite(ch.startTime) && ch.startTime > startSeconds + 15)
    .sort((a, b) => a.startTime - b.startTime);
  const cut = sorted.find(ch => ch.startTime >= minTarget && ch.startTime <= maxTarget);
  return cut ? { seconds: cut.startTime, title: cut.title || '', source: 'chapter' } : null;
}

function findTranscriptCut(raw, startSeconds, minSeconds, maxSeconds) {
  return findTranscriptCutNear(raw, startSeconds, minSeconds, maxSeconds);
}

function podcastAdCueScore(text = '') {
  const t = String(text || '').toLowerCase();
  let score = 0;
  const strong = [
    /\bsponsor(?:ed|s)?\b/,
    /\bthis episode is brought to you by\b/,
    /\bpartner(?:ed)? with\b/,
    /\buse (?:the )?code\b/,
    /\bpromo code\b/,
    /\bdiscount\b/,
    /\bforward slash\b/,
    /\bslash wbd\b/,
    /\bget started (?:today )?at\b/,
    /\bgo to\b/,
    /\bvisit\b/,
    /\bi recommend\b/,
    /\bsupport (?:the|this) show\b/,
  ];
  const brands = [
    /\bswan(?: bitcoin)?\b/,
    /\bbitkey\b/,
    /\bblockware\b/,
    /\bunchained\b/,
    /\briver\b/,
    /\bfold\b/,
    /\bkraken\b/,
    /\bledger\b/,
    /\bcoldcard\b/,
    /\bfoundation\b/,
  ];
  for (const rx of strong) if (rx.test(t)) score += 3;
  for (const rx of brands) if (rx.test(t)) score += 2;
  if (/\bbitcoiners, as you know\b/.test(t)) score += 4;
  if (/\b[a-z0-9.-]+\.(?:com|world|io|net)\b/.test(t)) score += 3;
  if (/\b(?:tax|inheritance|wealth|clients|device|wallet|mining|miners|self-custody)\b/.test(t) && score > 0) score += 1;
  return score;
}

function findPodcastAdBreak(raw, startSeconds, minSeconds, maxSeconds) {
  if (!engineSettings.podcastAdSkipEnabled) return null;
  const entries = parseCueEntries(raw);
  if (!entries.length) return null;
  const minTarget = startSeconds + minSeconds;
  const maxTarget = startSeconds + maxSeconds;
  const windowEntries = entries
    .filter(e => e.end >= minTarget - 45 && e.start <= maxTarget)
    .map((entry, index) => ({
      ...entry,
      index,
      adScore: podcastAdCueScore(entry.text),
    }));
  const firstAd = windowEntries.find(entry => entry.end >= minTarget && entry.adScore >= 4);
  if (!firstAd) return null;

  let startIndex = firstAd.index;
  while (startIndex > 0) {
    const prev = windowEntries[startIndex - 1];
    const current = windowEntries[startIndex];
    if (!prev || current.start - prev.end > 12) break;
    if (prev.adScore >= 2 || /^(bitcoiners|if you're|do you want|well,|and if|so if)\b/i.test(prev.text.trim())) {
      startIndex--;
      continue;
    }
    break;
  }

  let endIndex = firstAd.index;
  let lastStrongAdIndex = firstAd.index;
  for (let i = firstAd.index + 1; i < windowEntries.length; i++) {
    const prev = windowEntries[i - 1];
    const entry = windowEntries[i];
    const gap = entry.start - prev.end;
    if (gap > 18) break;
    if (entry.adScore >= 2) lastStrongAdIndex = i;
    const connective = /^(and|so|this|that|you|if|well|because|it|they|their|the|a dedicated|including|which|with|under|get|go|that's)\b/i.test(entry.text.trim());
    if (entry.adScore >= 1 || (connective && i - lastStrongAdIndex <= 4)) {
      endIndex = i;
      continue;
    }
    break;
  }

  const startEntry = windowEntries[startIndex];
  const endEntry = windowEntries[endIndex];
  const adStartSeconds = Math.max(minTarget, startEntry.start);
  const adEndSeconds = Math.min(maxTarget, endEntry.end);
  if (adEndSeconds - adStartSeconds < 20) return null;
  return {
    startSeconds: adStartSeconds,
    endSeconds: adEndSeconds,
    source: 'transcriptAd',
    title: 'Podcast ad break',
    excerpt: windowEntries.slice(startIndex, Math.min(endIndex + 1, startIndex + 8)).map(e => e.text).join(' ').slice(0, 320),
  };
}

function findTranscriptCutNear(raw, startSeconds, minSeconds, maxSeconds, anchorSeconds = null) {
  const entries = parseCueEntries(raw);
  if (!entries.length) return null;
  const minTarget = startSeconds + minSeconds;
  const maxTarget = startSeconds + maxSeconds;
  const anchor = Number(anchorSeconds);
  const terminal = /[.!?…]["')\]]*$/;
  const candidates = [];
  for (let i = 0; i < entries.length; i++) {
    const cue = entries[i];
    if (cue.end < minTarget || cue.end > maxTarget) continue;
    const next = entries[i + 1];
    const gap = next ? next.start - cue.end : 2;
    const text = String(cue.text || '').trim();
    const words = text.split(/\s+/).filter(Boolean).length;
    if (terminal.test(text) && words >= 6 && gap >= 0.25) {
      candidates.push({ seconds: cue.end, title: '', source: 'transcriptCue', gapSeconds: gap, words });
    }
  }
  if (!candidates.length) return null;
  if (Number.isFinite(anchor)) {
    const near = candidates
      .filter(candidate => Math.abs(candidate.seconds - anchor) <= 120)
      .sort((a, b) => Math.abs(a.seconds - anchor) - Math.abs(b.seconds - anchor));
    if (near[0]) return { ...near[0], anchorSeconds: anchor };
  }
  return candidates[0];
}

async function fetchTranscriptRawForEpisode(item, episodeState) {
  const episode = item.episode || {
    id: episodeState.guid || item.id,
    feedTitle: episodeState.showTitle,
    title: episodeState.episodeTitle,
    audioUrl: episodeState.episodeUrl || item.liveUrl,
    transcriptUrl: episodeState.transcriptUrl,
  };
  const cached = readCachedPodcastTranscript(episode);
  if (cached?.status === 'completed') return transcriptRecordToRaw(cached);
  if (episodeState.transcriptUrl) return fetchTranscriptRaw(episodeState.transcriptUrl);
  return '';
}

function parseSilenceCut(stderr, windowStartSeconds, minTarget, maxTarget, anchorSeconds = null) {
  const starts = [...String(stderr || '').matchAll(/silence_start:\s*([0-9.]+)/g)]
    .map(m => Number(m[1]))
    .filter(Number.isFinite);
  const anchor = Number(anchorSeconds);
  const candidates = [];

  for (const raw of starts) {
    const absolute = raw >= minTarget - 0.5 ? raw : windowStartSeconds + raw;
    const clamped = Math.max(minTarget, absolute);
    if (clamped >= minTarget && clamped <= maxTarget) {
      candidates.push({ seconds: clamped, title: '', source: 'silence' });
    }
  }

  if (!candidates.length) return null;
  if (Number.isFinite(anchor)) {
    candidates.sort((a, b) => Math.abs(a.seconds - anchor) - Math.abs(b.seconds - anchor));
    return { ...candidates[0], anchorSeconds: anchor };
  }
  return candidates[0];
}

async function findSilenceCut(item, startSeconds, minSeconds, maxSeconds, options = {}) {
  const minTarget = startSeconds + minSeconds;
  const maxTarget = startSeconds + maxSeconds;
  const anchor = Number(options.anchorSeconds);
  const hasAnchor = Number.isFinite(anchor);
  const windowStart = hasAnchor
    ? Math.max(minTarget, anchor - Number(options.beforeSeconds ?? 45))
    : minTarget;
  const windowEnd = hasAnchor
    ? Math.min(maxTarget, anchor + Number(options.afterSeconds ?? 90))
    : maxTarget;
  const windowDuration = Math.max(1, windowEnd - windowStart);
  try {
    const result = await runCommand('ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'info',
      '-ss', String(Math.floor(windowStart)),
      '-t', String(Math.ceil(windowDuration)),
      '-i', item.liveUrl,
      '-vn',
      '-af', 'silencedetect=noise=-35dB:d=1.0',
      '-f', 'null',
      '-',
    ], Math.ceil((windowDuration + 90) * 1000));
    const cut = parseSilenceCut(result.stderr, windowStart, minTarget, maxTarget, hasAnchor ? anchor : null);
    if (cut) return cut;
    if (!result.ok) console.warn('[engine] podcast silence detect failed:', result.stderr.split(/\r?\n/).slice(-3).join(' | '));
  } catch(e) {
    console.warn('[engine] podcast silence detect failed:', e.message);
  }
  return null;
}

async function choosePodcastSegment(item, episodeState) {
  const { minSeconds, maxSeconds } = normalizePodcastSegmentSettings();
  const startSeconds = Math.max(0, Number(episodeState.positionSeconds || 0));
  const durationSeconds = Number(episodeState.durationSeconds || item.duration || 0);
  const hardMaxEnd = durationSeconds > 0
    ? Math.min(startSeconds + maxSeconds, durationSeconds)
    : startSeconds + maxSeconds;
  let semanticCut = null;
  let cut = null;
  let transcriptRaw = '';
  let adBreak = null;
  const refinement = [];

  if (engineSettings.podcastPreferTranscriptChapters !== false) {
    const chapterCut = findChapterCut(episodeState.chapters, startSeconds, minSeconds, maxSeconds);
    if (chapterCut) {
      semanticCut = chapterCut;
      refinement.push('chapter');
      console.log(`[engine] podcast break anchor: chapter @ ${Math.round(chapterCut.seconds)}s${chapterCut.title ? ` (${chapterCut.title})` : ''}`);
    }
    if (episodeState.transcriptUrl || readCachedPodcastTranscript(item.episode || item)?.status === 'completed') {
      try {
        transcriptRaw = await fetchTranscriptRawForEpisode(item, episodeState);
        const transcriptCut = findTranscriptCutNear(transcriptRaw, startSeconds, minSeconds, maxSeconds, chapterCut?.seconds ?? null);
        if (transcriptCut) {
          semanticCut = transcriptCut;
          refinement.push('transcriptCue');
          console.log(`[engine] podcast break anchor refined by transcriptCue @ ${Math.round(transcriptCut.seconds)}s gap=${Number(transcriptCut.gapSeconds || 0).toFixed(1)}s${chapterCut ? ` from chapter ${Math.round(chapterCut.seconds)}s` : ''}`);
        } else {
          console.log('[engine] podcast transcript had no logical break candidate in segment window');
        }
        adBreak = findPodcastAdBreak(transcriptRaw, startSeconds, minSeconds, maxSeconds);
        if (adBreak) {
          console.log(`[engine] podcast ad break detected: ${Math.round(adBreak.startSeconds)}s → ${Math.round(adBreak.endSeconds)}s (${adBreak.excerpt})`);
        }
      } catch(e) {
        console.warn('[engine] podcast transcript cut failed:', e.message);
      }
    }
  }

  if (semanticCut) {
    const silenceCut = await findSilenceCut(item, startSeconds, minSeconds, maxSeconds, {
      anchorSeconds: semanticCut.seconds,
      beforeSeconds: 45,
      afterSeconds: 90,
    });
    if (silenceCut) {
      cut = {
        ...silenceCut,
        title: semanticCut.title || silenceCut.title || '',
        semanticSource: semanticCut.source,
        semanticSeconds: semanticCut.seconds,
        detail: [...refinement, 'silence'].join('->'),
      };
      console.log(`[engine] podcast break anchor confirmed by silence @ ${Math.round(cut.seconds)}s (${cut.detail})`);
    } else {
      console.log(`[engine] podcast break anchor had no nearby silence confirmation @ ${Math.round(semanticCut.seconds)}s; trying full-window silence`);
    }
  }

  if (!cut) {
    const silenceCut = await findSilenceCut(item, startSeconds, minSeconds, maxSeconds);
    if (silenceCut) {
      cut = {
        ...silenceCut,
        title: semanticCut?.title || silenceCut.title || '',
        semanticSource: semanticCut?.source || '',
        semanticSeconds: semanticCut?.seconds || null,
        detail: semanticCut ? [...refinement, 'silence'].join('->') : 'silence',
      };
      console.log(`[engine] podcast break candidate accepted: silence @ ${Math.round(cut.seconds)}s${semanticCut ? ` after unconfirmed ${semanticCut.source}` : ''}`);
    }
  }

  if (!cut && semanticCut) {
    cut = {
      ...semanticCut,
      detail: [...refinement, 'unconfirmed'].join('->'),
    };
    console.log(`[engine] podcast break candidate accepted without silence confirmation: ${semanticCut.source} @ ${Math.round(cut.seconds)}s (${cut.detail})`);
  }

  if (adBreak && adBreak.startSeconds >= startSeconds + minSeconds) {
    const plannedCutSeconds = cut?.seconds || hardMaxEnd;
    if (adBreak.startSeconds <= plannedCutSeconds + 30) {
      cut = {
        seconds: adBreak.startSeconds,
        title: adBreak.title,
        source: 'adBreak',
        detail: `${cut?.detail || cut?.source || 'segment'}->adBreak`,
        adSkipStartSeconds: adBreak.startSeconds,
        adSkipEndSeconds: adBreak.endSeconds,
        adExcerpt: adBreak.excerpt,
      };
      console.log(`[engine] podcast segment will stop before ad and resume after it: ${Math.round(adBreak.startSeconds)}s → ${Math.round(adBreak.endSeconds)}s`);
    }
  }

  const endSeconds = Math.min(Math.max(cut?.seconds || hardMaxEnd, startSeconds + minSeconds), hardMaxEnd);
  if (!cut) console.log(`[engine] podcast break candidate accepted: hardMax @ ${Math.round(endSeconds)}s`);
  return {
    startSeconds,
    endSeconds,
    durationSeconds: Math.max(1, endSeconds - startSeconds),
    minSeconds,
    maxSeconds,
    cutSource: cut?.source || 'hardMax',
    cutDetail: cut?.detail || cut?.source || 'hardMax',
    semanticSource: cut?.semanticSource || (cut?.source && cut.source !== 'silence' ? cut.source : ''),
    semanticSeconds: cut?.semanticSeconds ?? (cut?.source && cut.source !== 'silence' ? cut.seconds : null),
    adSkipStartSeconds: cut?.adSkipStartSeconds || null,
    adSkipEndSeconds: cut?.adSkipEndSeconds || null,
    adExcerpt: cut?.adExcerpt || '',
    chapterTitle: cut?.title || '',
    transcriptRaw,
  };
}

function currentChapterTitle(chapters, startSeconds, endSeconds) {
  if (!Array.isArray(chapters) || !chapters.length) return '';
  const sorted = chapters
    .map(ch => ({ ...ch, startTime: Number(ch.startTime ?? ch.start ?? 0) }))
    .filter(ch => Number.isFinite(ch.startTime))
    .sort((a, b) => a.startTime - b.startTime);
  let current = null;
  for (const ch of sorted) {
    if (ch.startTime <= Math.max(startSeconds, endSeconds - 1)) current = ch;
    else break;
  }
  return current?.title || '';
}

async function extractSttExcerpt(item, startSeconds, endSeconds) {
  if (!engineSettings.podcastSttFallbackEnabled) return '';
  const extractStart = Math.max(startSeconds, endSeconds - 90);
  const duration = Math.max(20, endSeconds - extractStart);
  const tmpFile = path.join(TMP_DIR, `podcast-stt-${Date.now()}.mp3`);
  try {
    const ffmpeg = await runCommand('ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', String(Math.floor(extractStart)),
      '-t', String(Math.ceil(duration)),
      '-i', item.liveUrl,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-y',
      tmpFile,
    ], 120_000);
    if (!ffmpeg.ok) throw new Error(ffmpeg.stderr || 'ffmpeg stt extract failed');
    const buf = await readFile(tmpFile);
    if (buf.length < 1000) throw new Error(`STT extract tiny file (${buf.length} bytes)`);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'segment.mp3');
    form.append('model_id', 'scribe_v2');
    form.append('word_timestamps', 'true');
    const res = await fetch(PODCAST_STT_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const json = await res.json();
    return String(json.text || json.transcript || '').trim();
  } catch(e) {
    console.warn('[engine] podcast STT fallback failed:', e.message);
    return '';
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

async function buildPodcastSegmentContext(item, episodeState, segment) {
  let source = 'fallback';
  let excerpt = '';
  let transcriptRaw = segment.transcriptRaw || '';

  if (episodeState.transcriptUrl || readCachedPodcastTranscript(item.episode || item)?.status === 'completed') {
    try {
      if (!transcriptRaw) transcriptRaw = await fetchTranscriptRawForEpisode(item, episodeState);
      excerpt = extractTranscriptWindow(transcriptRaw, segment.startSeconds, segment.endSeconds);
      if (excerpt.length > 40) source = 'transcript';
    } catch(e) {
      console.warn('[engine] podcast transcript context failed:', e.message);
    }
  }

  const chapterTitle = segment.chapterTitle || currentChapterTitle(episodeState.chapters, segment.startSeconds, segment.endSeconds);
  if (source === 'fallback' && chapterTitle) {
    excerpt = `Aktuelles Kapitel: ${chapterTitle}. ${episodeState.description || ''}`.trim();
    source = 'chapter';
  }

  if (source === 'fallback' && engineSettings.podcastSttFallbackEnabled) {
    const stt = await extractSttExcerpt(item, segment.startSeconds, segment.endSeconds);
    if (stt.length > 20) {
      excerpt = stt;
      source = 'stt';
    }
  }

  if (source === 'fallback') {
    excerpt = episodeState.description || 'Kein belastbarer Transcript- oder Kapitelkontext vorhanden.';
  }

  return {
    source,
    excerpt,
    chapterTitle,
  };
}

async function generatePodcastModerationText(item, episodeState, segment, context, memoryContext = '') {
  try {
    const system = moderatorSystemPrompt([
      'Erzeuge eine kurze Podcast-Abmoderation auf Deutsch.',
      'Keine trockene Inhaltszusammenfassung. Nimm den gehoerten Abschnitt als Material fuer eine persoenliche Beobachtung, einen Kommentar oder einen gedanklichen Anschluss.',
      'Wenn du konkret zusammenfasst, dann nur als Sprungbrett fuer deinen Kommentar.',
      'Kein generisches "spannendes Gespraech". Nutze den Transcript-/STT-/Kapitel-Kontext.',
      'Wichtig: Verwende nur den Kontext des angegebenen Segment-Zeitfensters, nicht das gesamte Podcast-Transkript.',
      'Dann leite organisch in Musik ueber.',
      'Wenn kein brauchbarer Kontext vorhanden ist, sag das ehrlich und knapp. Nicht halluzinieren.',
    ].join(' '));
    const task = [
      `Show: ${episodeState.showTitle}`,
      `Episode: ${episodeState.episodeTitle}`,
      `Part: ${episodeState.part}`,
      `Segment: ${Math.round(segment.startSeconds)}s bis ${Math.round(segment.endSeconds)}s`,
      context.chapterTitle ? `Kapitel: ${context.chapterTitle}` : '',
      `Kontextquelle: ${context.source}`,
      '',
      `Kontext:\n${String(context.excerpt || '').slice(0, 2200)}`,
      memoryContext,
    ].filter(Boolean).join('\n');
    const res = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 220,
        purpose: 'radio-moderation',
        system,
        messages: [{ role: 'user', content: task }],
      }),
      signal: AbortSignal.timeout(110_000),
    });
    if (!res.ok) throw new Error(`claude-proxy HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const json = await res.json();
    const text = sanitizeModerationText(json?.content?.[0]?.text || '');
    return text || null;
  } catch(e) {
    console.warn('[engine] podcast moderation text failed:', e.message);
    return null;
  }
}

async function buildPodcastModerationItem(item, episodeState, segment, context) {
  console.log(`[engine] generating podcast moderation (${context.source})…`);
  const compiled = memorySafe('podcast moderation context', () => buildPodcastModerationContext({ item, episodeState, segment, context })) || { promptText: '', callInIds: [] };
  const text = sanitizeModerationText(await generatePodcastModerationText(item, episodeState, segment, context, compiled.promptText));
  const fallback = `Das war ein Abschnitt aus ${episodeState.showTitle}: ${episodeState.episodeTitle}. Für die genaue Einordnung fehlt mir gerade belastbarer Kontext, deshalb halten wir es ehrlich kurz und lassen das Gehörte mit Musik nachklingen.`;
  const tts = await ttsToTempFile(text || fallback);
  if (!tts?.file) return null;
  const scriptText = text || fallback;
  memorySafe('record podcast moderation', () => {
    recordModeration({ purpose: 'podcast-segment', item, scriptText, context: { ...context, callInIds: compiled.callInIds } });
    markCallInsUsed(compiled.callInIds, { purpose: 'podcast-segment' });
  });
  return {
    kind: 'moderation',
    id: `podcast-mod-${Date.now()}`,
    title: 'Podcast Moderation',
    artist: 'Radio Host',
    artworkUrl: '',
    liveUrl: tts.file,
    duration: tts.durationSeconds || 0,
    tmpFile: tts.file,
    scriptText,
    plannedNextKind: 'music',
  };
}

async function generatePodcastIntroText(item, episodeState, isResume, memoryContext = '', introContext = null) {
  try {
    const system = moderatorSystemPrompt([
      'Erzeuge eine sehr kurze, warme Podcast-Anmoderation auf Deutsch.',
      'Erwaehne primaer den Sendungsnamen, nicht unnoetig Datum, Uhrzeit oder Episodennummern.',
      'Wenn Kontext vorhanden ist, mische ihn mit deiner Haltung statt nur den Klappentext nachzuerzaehlen.',
      'Erwaehne keine naechste Musik. Fokus nur auf den Podcast.',
    ].join(' '));
    const minutes = Math.floor(Number(episodeState.positionSeconds || 0) / 60);
    const task = isResume
      ? [
          `Sendung: ${episodeState.showTitle}`,
          `Episode: ${episodeState.episodeTitle}`,
          `Resume-Position: ca. Minute ${minutes}`,
          episodeState.lastContextSource ? `Letzte Kontextquelle: ${episodeState.lastContextSource}` : '',
          memoryContext,
          '',
          'Nimm den Podcast kurz wieder auf. Maximal 25 Wörter. Klinge wie ein Moderator, der weiß, dass wir schon mittendrin waren.',
        ].filter(Boolean).join('\n')
      : [
          `Sendung: ${episodeState.showTitle}`,
          `Episode: ${episodeState.episodeTitle}`,
          introContext?.text ? `Podcast-Kontext (${introContext.source}): ${String(introContext.text).slice(0, 900)}` : '',
          memoryContext,
          '',
          'Moderiere diesen Podcast kurz an. Maximal 30 Wörter. Warm, klar, nicht werblich.',
        ].filter(Boolean).join('\n');
    const res = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 90,
        purpose: 'radio-moderation',
        system,
        messages: [{ role: 'user', content: task }],
      }),
      signal: AbortSignal.timeout(110_000),
    });
    if (!res.ok) throw new Error(`claude-proxy HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const json = await res.json();
    const text = sanitizeModerationText(json?.content?.[0]?.text || '');
    return text || null;
  } catch(e) {
    console.warn('[engine] podcast intro text failed:', e.message);
    return null;
  }
}

async function buildPodcastIntroItem(item, episodeState, isResume) {
  const compiled = memorySafe('podcast intro context', () => buildPodcastIntroContext({ item, episodeState, isResume })) || { promptText: '', callInIds: [] };
  const introContext = isResume ? null : await getPodcastIntroContextText(item, episodeState);
  const text = sanitizeModerationText(await generatePodcastIntroText(item, episodeState, isResume, compiled.promptText, introContext));
  const fallback = isResume
    ? `Und wir gehen zurück in ${episodeState.showTitle}, ungefähr ab Minute ${Math.max(1, Math.floor(Number(episodeState.positionSeconds || 0) / 60))}.`
    : `Zeit für ${episodeState.showTitle}. Wir hören kurz rein.`;
  const tts = await ttsToTempFile(text || fallback);
  if (!tts?.file) return null;
  const scriptText = text || fallback;
  memorySafe('record podcast intro moderation', () => {
    recordModeration({ purpose: isResume ? 'podcast-resume-intro' : 'podcast-intro', item, scriptText, context: { callInIds: compiled.callInIds } });
    markCallInsUsed(compiled.callInIds, { purpose: isResume ? 'podcast-resume-intro' : 'podcast-intro' });
  });
  return {
    kind: 'moderation',
    id: `podcast-intro-${Date.now()}`,
    title: 'Podcast Intro',
    artist: 'Radio Host',
    artworkUrl: item.artworkUrl || '',
    liveUrl: tts.file,
    duration: tts.durationSeconds || 0,
    tmpFile: tts.file,
    scriptText,
    plannedNextKind: 'podcast',
  };
}

async function buildPodcastReturnItem(episodeState) {
  const part = Math.max(2, Number(episodeState.part || 2));
  const text = `Und wir sind zurück bei ${episodeState.showTitle}. Weiter geht es mit Teil ${part} von ${episodeState.episodeTitle}.`;
  const tts = await ttsToTempFile(text);
  if (!tts?.file) return null;
  memorySafe('record podcast return moderation', () => {
    recordModeration({ purpose: 'podcast-return', item: { kind: 'podcast', title: episodeState.episodeTitle, artist: episodeState.showTitle }, scriptText: text });
  });
  return {
    kind: 'moderation',
    id: `podcast-return-${Date.now()}`,
    title: 'Podcast Return',
    artist: 'Radio Host',
    artworkUrl: '',
    liveUrl: tts.file,
    duration: tts.durationSeconds || 0,
    tmpFile: tts.file,
    scriptText: text,
    plannedNextKind: 'podcast',
  };
}

function buildJingleItem(file, title) {
  if (!existsSync(file)) return null;
  return {
    kind: 'jingle',
    id: `jingle-${Date.now()}`,
    title,
    artist: 'Personal Radio',
    artworkUrl: '',
    liveUrl: file,
    duration: 0,
  };
}

function choosePodcastBreakSongs() {
  const configured = Number(engineSettings.musicBreakTracksAfterPodcast || 0);
  if (Number.isFinite(configured) && configured > 0) return Math.max(1, Math.min(6, Math.round(configured)));
  return 1 + Math.floor(Math.random() * 3);
}

function cleanupPreparedPodcastSegment(prepared) {
  if (prepared?.segmentPlaybackFile) { try { unlinkSync(prepared.segmentPlaybackFile); } catch {} }
}

function clearPendingPodcastSegmentPrefetch() {
  for (const pending of podcastSegmentPrefetches.values()) {
    pending.then(cleanupPreparedPodcastSegment).catch(() => {});
  }
  podcastSegmentPrefetches.clear();
  for (const prepared of preparedPodcastSegmentCache.values()) {
    cleanupPreparedPodcastSegment(prepared);
  }
  preparedPodcastSegmentCache.clear();
}

function normalizeEpisodeStateForSegment(item) {
  const { episodeKey, state } = getEpisodeState(item);
  if (state.completed) {
    state.positionSeconds = 0;
    state.completed = false;
    state.part = 1;
  }
  return { episodeKey, state };
}

function podcastSegmentPlanKey(episodeKey, state) {
  const { minSeconds, maxSeconds } = normalizePodcastSegmentSettings();
  return [
    episodeKey,
    Math.max(0, Math.floor(Number(state.positionSeconds || 0))),
    Math.max(1, Math.floor(Number(state.part || 1))),
    Math.round(minSeconds),
    Math.round(maxSeconds),
    engineSettings.podcastPreferTranscriptChapters === false ? 'no-cues' : 'cues',
  ].join('|');
}

function cleanupOldPreparedPodcastSegments() {
  const ttl = Number.isFinite(PODCAST_SEGMENT_PREFETCH_TTL_MS) && PODCAST_SEGMENT_PREFETCH_TTL_MS > 0
    ? PODCAST_SEGMENT_PREFETCH_TTL_MS
    : 30 * 60_000;
  const maxEntries = Number.isFinite(PODCAST_SEGMENT_PREFETCH_MAX) && PODCAST_SEGMENT_PREFETCH_MAX > 0
    ? Math.floor(PODCAST_SEGMENT_PREFETCH_MAX)
    : 4;
  const now = Date.now();
  for (const [key, prepared] of preparedPodcastSegmentCache.entries()) {
    if (!prepared?.segmentPlaybackFile
        || !existsSync(prepared.segmentPlaybackFile)
        || now - Number(prepared.createdAt || 0) > ttl) {
      cleanupPreparedPodcastSegment(prepared);
      preparedPodcastSegmentCache.delete(key);
    }
  }
  const rows = [...preparedPodcastSegmentCache.entries()]
    .sort((a, b) => Number(b[1]?.createdAt || 0) - Number(a[1]?.createdAt || 0));
  for (const [key, prepared] of rows.slice(maxEntries)) {
    cleanupPreparedPodcastSegment(prepared);
    preparedPodcastSegmentCache.delete(key);
  }
}

async function preparePodcastSegment(item) {
  const { episodeKey, state } = normalizeEpisodeStateForSegment(item);
  const planKey = podcastSegmentPlanKey(episodeKey, state);
  const resolvedAudioUrl = await resolvePodcastAudioUrl(item, state);
  const resolvedItem = { ...item, liveUrl: resolvedAudioUrl };
  const segment = await choosePodcastSegment(resolvedItem, state);
  let segmentPlaybackFile = null;
  let segmentPlaybackSource = 'resolvedUrl';
  try {
    segmentPlaybackFile = await buildPodcastSegmentPlaybackFile(segment, resolvedAudioUrl);
    if (segmentPlaybackFile) segmentPlaybackSource = 'segmentCache';
  } catch (err) {
    console.warn(`[engine] podcast segment cache failed, falling back to resolved URL: ${err.message}`);
  }
  return {
    planKey,
    episodeKey,
    state,
    resolvedItem,
    resolvedAudioUrl,
    segment,
    segmentPlaybackFile,
    segmentPlaybackSource,
    createdAt: Date.now(),
  };
}

function prefetchPodcastSegment(item) {
  if (!item || item.kind !== 'podcast') return;
  const { episodeKey, state } = normalizeEpisodeStateForSegment(item);
  const planKey = podcastSegmentPlanKey(episodeKey, state);
  cleanupOldPreparedPodcastSegments();
  if (preparedPodcastSegmentCache.has(planKey) || podcastSegmentPrefetches.has(planKey)) return;
  const promise = preparePodcastSegment(item)
    .then(prepared => {
      if (prepared) {
        preparedPodcastSegmentCache.set(prepared.planKey, prepared);
        cleanupOldPreparedPodcastSegments();
        console.log(`[engine] podcast segment pre-cached, ready: ${prepared.state.showTitle} — ${prepared.state.episodeTitle}`);
      }
      return prepared;
    })
    .catch(err => {
      console.warn(`[engine] podcast segment pre-cache failed: ${err.message}`);
      return null;
    })
    .finally(() => {
      podcastSegmentPrefetches.delete(planKey);
    });
  podcastSegmentPrefetches.set(planKey, promise);
}

async function playPodcastSegment(item) {
  podcastSessionActive = true;
  const { episodeKey: plannedEpisodeKey, state: plannedState } = normalizeEpisodeStateForSegment(item);
  const planKey = podcastSegmentPlanKey(plannedEpisodeKey, plannedState);
  let prepared = preparedPodcastSegmentCache.get(planKey) || null;
  if (prepared) {
    preparedPodcastSegmentCache.delete(planKey);
    console.log(`[engine] using pre-cached podcast segment: ${prepared.state.showTitle} — ${prepared.state.episodeTitle}`);
  } else if (podcastSegmentPrefetches.has(planKey)) {
    prepared = await podcastSegmentPrefetches.get(planKey);
    podcastSegmentPrefetches.delete(planKey);
    preparedPodcastSegmentCache.delete(planKey);
    if (prepared) console.log(`[engine] using just-finished podcast segment pre-cache: ${prepared.state.showTitle} — ${prepared.state.episodeTitle}`);
  }
  if (!prepared) prepared = await preparePodcastSegment(item);

  const {
    episodeKey,
    state,
    resolvedItem,
    resolvedAudioUrl,
    segment,
    segmentPlaybackFile,
    segmentPlaybackSource,
  } = prepared;

  currentPodcastPlayback = {
    episodeKey,
    showTitle: state.showTitle,
    episodeTitle: state.episodeTitle,
    currentPositionSeconds: segment.startSeconds,
    durationSeconds: state.durationSeconds || item.duration || 0,
    part: state.part,
    segmentStartSeconds: segment.startSeconds,
    segmentEndSeconds: segment.endSeconds,
    breakReason: segment.cutSource,
    breakReasonDetail: segment.cutDetail,
    adSkipStartSeconds: segment.adSkipStartSeconds,
    adSkipEndSeconds: segment.adSkipEndSeconds,
    playbackSource: segmentPlaybackSource,
    hasTranscript: !!state.transcriptUrl || !!readCachedPodcastTranscript(item.episode || item)?.text,
    hasChapters: Array.isArray(state.chapters) && state.chapters.length > 0,
  };
  podcastState.active = currentPodcastPlayback;
  podcastState.currentEpisodeKey = episodeKey;
  savePodcastState();

  console.log(`[engine] podcast segment part ${state.part}: ${Math.round(segment.startSeconds)}s → ${Math.round(segment.endSeconds)}s breakReason=${segment.cutSource} detail=${segment.cutDetail} playback=${segmentPlaybackSource}`);
  broadcastStatus();

  const startedMs = Date.now();
  const playbackItem = { ...item, liveUrl: segmentPlaybackFile || resolvedAudioUrl };
  const checkpointPodcastPosition = () => {
    const elapsed = Math.max(0, Math.min(segment.durationSeconds, (Date.now() - startedMs) / 1000));
    const checkpoint = Math.min(segment.endSeconds, segment.startSeconds + elapsed);
    state.positionSeconds = checkpoint;
    state.completed = false;
    state.lastSegmentStart = segment.startSeconds;
    state.lastSegmentEnd = checkpoint;
    podcastState.episodes[episodeKey] = state;
    podcastState.currentEpisodeKey = episodeKey;
    if (currentPodcastPlayback?.episodeKey === episodeKey) {
      currentPodcastPlayback.currentPositionSeconds = checkpoint;
      podcastState.active = currentPodcastPlayback;
    }
    savePodcastState();
  };
  let podcastCheckpointTimer = null;
  try {
    podcastCheckpointTimer = setInterval(checkpointPodcastPosition, 15_000);
    await playItemOnAllOutputs(playbackItem, {
      startSeconds: segmentPlaybackFile ? 0 : segment.startSeconds,
      durationSeconds: segmentPlaybackFile ? 0 : segment.durationSeconds,
      hardStopMs: Math.ceil((segment.durationSeconds + 5) * 1000),
      cacheHttpAudio: false,
    });
  } finally {
    if (podcastCheckpointTimer) clearInterval(podcastCheckpointTimer);
    checkpointPodcastPosition();
  }
  if (segmentPlaybackFile) { try { unlinkSync(segmentPlaybackFile); } catch {} }

  const actualElapsed = Math.max(0, Math.min(segment.durationSeconds, (Date.now() - startedMs) / 1000));
  const endPosition = itemWasKilled
    ? Math.min(segment.endSeconds, segment.startSeconds + actualElapsed)
    : segment.endSeconds;
  const resumePosition = !itemWasKilled && segment.adSkipEndSeconds && segment.adSkipEndSeconds > endPosition
    ? segment.adSkipEndSeconds
    : endPosition;
  const reachedEpisodeEnd = state.durationSeconds > 0 && resumePosition >= state.durationSeconds - 5;

  state.positionSeconds = reachedEpisodeEnd ? 0 : resumePosition;
  state.durationSeconds = state.durationSeconds || item.duration || 0;
  state.part = reachedEpisodeEnd ? 1 : state.part + 1;
  state.completed = reachedEpisodeEnd;
  state.lastSegmentStart = segment.startSeconds;
  state.lastSegmentEnd = endPosition;
  if (segment.adSkipStartSeconds && segment.adSkipEndSeconds && !itemWasKilled) {
    state.lastSkippedAd = {
      startSeconds: segment.adSkipStartSeconds,
      endSeconds: segment.adSkipEndSeconds,
      excerpt: segment.adExcerpt || '',
      skippedAt: new Date().toISOString(),
    };
  }
  console.log(`[engine] podcast resume boundary saved: ${Math.round(state.positionSeconds)}s completed=${reachedEpisodeEnd}`);

  let context = { source: 'fallback', excerpt: '', chapterTitle: '' };
  const shouldModerate = (!itemWasKilled || podcastSegmentSkipRequested) && actualElapsed >= 1;
  if (shouldModerate) {
    context = await buildPodcastSegmentContext(resolvedItem, state, { ...segment, endSeconds: endPosition });
    state.lastContextSource = context.source;
  }

  podcastState.lastSegment = {
    episodeKey,
    showTitle: state.showTitle,
    episodeTitle: state.episodeTitle,
    part: reachedEpisodeEnd ? Math.max(1, state.part - 1) : state.part - 1,
    startSeconds: segment.startSeconds,
    endSeconds: endPosition,
    plannedEndSeconds: segment.endSeconds,
    resumePositionSeconds: resumePosition,
    breakReason: segment.cutSource,
    breakReasonDetail: segment.cutDetail,
    adSkipStartSeconds: segment.adSkipStartSeconds || null,
    adSkipEndSeconds: segment.adSkipEndSeconds || null,
    playbackSource: segmentPlaybackSource,
    contextSource: context.source,
    chapterTitle: context.chapterTitle,
    completed: reachedEpisodeEnd,
    skipped: podcastSegmentSkipRequested,
    savedAt: new Date().toISOString(),
  };
  podcastState.active = null;
  currentPodcastPlayback = null;
  podcastState.episodes[episodeKey] = state;
  savePodcastState();
  if (shouldModerate) {
    memorySafe('record podcast segment', () => {
      recordPodcastSegment({
        episodeKey,
        item,
        state,
        segment: { ...segment, endSeconds: endPosition },
        context,
      });
    });
  }
  broadcastStatus();

  const wasSegmentSkip = podcastSegmentSkipRequested;
  podcastSegmentSkipRequested = false;
  return {
    episodeKey,
    state,
    segment: { ...segment, endSeconds: endPosition },
    context,
    shouldModerate,
    completed: reachedEpisodeEnd,
    skipped: wasSegmentSkip,
  };
}

// ── Moderation (TTS) ──────────────────────────────────────────────────────────

function describeUpcomingItem(item) {
  if (!item) return 'Noch nicht festgelegt.';
  if (item.kind === 'podcast') return `Podcast als Nächstes: "${item.artist} — ${item.title}".`;
  if (item.kind === 'music') return `Nächster Song: "${item.artist} — ${item.title}".`;
  if (item.kind === 'moderation') return `Als Nächstes kommt eine weitere Moderation.`;
  return `Als Nächstes: "${item.artist || item.kind} — ${item.title}".`;
}

function moderationPlanKey(item) {
  if (!item) return 'none';
  return [
    item.kind || 'unknown',
    item.id || '',
    item.guid || '',
    item.liveUrl || item.audioUrl || '',
    item.artist || '',
    item.title || '',
  ].join('|');
}

function crossfadeSeconds() {
  const seconds = Number(engineSettings.crossfadeSeconds ?? 5);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(12, Math.max(1, seconds)) : 5;
}

function moderationDuckSeconds() {
  const seconds = Number(engineSettings.moderationDuckSeconds ?? 4);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(10, Math.max(1, seconds)) : 4;
}

function moderationDueAfterCurrentMusic() {
  const moderationAfterSongs = Number(engineSettings.moderationAfterSongs);
  return engineSettings.moderationEnabled
    && moderationAfterSongs > 0
    && Number.isFinite(moderationAfterSongs)
    && (songCount + 1) >= moderationAfterSongs;
}

function musicCanCrossfade(item, resumeStartSeconds = 0) {
  if (engineSettings.crossfadeEnabled === false) return false;
  if (item?.kind !== 'music') return false;
  if (resumeStartSeconds > 0) return false;
  if (sessionIntroRequest) return false;
  if (moderationDueAfterCurrentMusic()) return false;
  if (isPodcastDueAfterCurrentMusic()) return false;
  const duration = Number(item.duration || 0);
  const fade = crossfadeSeconds();
  return Number.isFinite(duration) && duration > fade * 2 + 8 && peekNextMusicItem();
}

function musicCanDuckIntoModeration(item, resumeStartSeconds = 0) {
  if (engineSettings.moderationDuckingEnabled === false) return false;
  if (item?.kind !== 'music') return false;
  if (resumeStartSeconds > 0) return false;
  if (sessionIntroRequest) return false;
  if (!moderationDueAfterCurrentMusic()) return false;
  if (pendingModerationPromise === null) return false;
  const duration = Number(item.duration || 0);
  const fade = moderationDuckSeconds();
  return Number.isFinite(duration) && duration > fade + 8;
}

function transitionStartFromAnalysis(item, fadeSeconds) {
  const duration = Number(item?.duration || 0);
  const fallback = Math.max(0, duration - fadeSeconds);
  if (!Number.isFinite(duration) || duration <= fadeSeconds + 8) return { startSeconds: fallback, reason: 'duration' };
  const analysis = getAudioAnalysis(item);
  if (!analysis) {
    return { startSeconds: fallback, reason: 'duration' };
  }
  const analyzedStart = Number(analysis.transitionStartSeconds);
  if (!Number.isFinite(analyzedStart)) return { startSeconds: fallback, reason: 'duration' };
  const clamped = Math.max(duration - 16, Math.min(duration - 1.5, analyzedStart));
  return {
    startSeconds: clamped,
    reason: analysis.transitionReason || 'analysis',
  };
}

function musicCrossfadeOptions(item, resumeStartSeconds = 0) {
  if (musicCanDuckIntoModeration(item, resumeStartSeconds)) {
    const fade = moderationDuckSeconds();
    const transition = transitionStartFromAnalysis(item, fade);
    return {
      fadeOutStartSeconds: transition.startSeconds,
      fadeOutSeconds: fade,
      resolveEarlyAfterMs: Math.max(1000, transition.startSeconds * 1000),
      allowOverlapTail: true,
      transitionReason: 'music-to-moderation-duck',
      transitionDetail: transition.reason,
      useOutroAnalysis: true,
      analysisItem: item,
    };
  }
  if (!musicCanCrossfade(item, resumeStartSeconds)) return {};
  const fade = crossfadeSeconds();
  const transition = transitionStartFromAnalysis(item, fade);
  return {
    fadeOutStartSeconds: transition.startSeconds,
    fadeOutSeconds: fade,
    resolveEarlyAfterMs: Math.max(1000, transition.startSeconds * 1000),
    allowOverlapTail: true,
    transitionReason: 'music-crossfade',
    transitionDetail: transition.reason,
    useOutroAnalysis: true,
    analysisItem: item,
  };
}

function moderationToMusicOptions(item) {
  if (engineSettings.moderationDuckingEnabled === false) return {};
  if (item?.kind !== 'moderation') return {};
  if (item.plannedNextKind !== 'music') return {};
  const fade = moderationDuckSeconds();
  const duration = Number(item.duration || 0);
  if (!Number.isFinite(duration) || duration <= fade + 1) return {};
  return {
    resolveEarlyAfterMs: Math.max(1000, (duration - fade) * 1000),
    allowOverlapTail: true,
    transitionReason: 'moderation-to-music-duck',
    nextMusicFadeInSeconds: fade,
  };
}

function peekNextMusicItem() {
  const item = queue.find(t => !isBlocked(t));
  return item ? { ...item } : null;
}

async function peekNextPodcastEpisode() {
  const queued = Array.isArray(engineSettings.podcastQueue) ? engineSettings.podcastQueue : [];
  const episode = queued.find(ep => ep?.audioUrl || ep?.liveUrl);
  if (episode) return podcastEpisodeToItem(episode);
  return fetchLatestPodcastEpisode();
}

function isPodcastDueAfterCurrentMusic() {
  const podcastAfterSongs = Number(engineSettings.podcastAfterSongs);
  return engineSettings.podcastsEnabled !== false
    && podcastBreakSongsRemaining <= 0
    && Number.isFinite(podcastAfterSongs)
    && podcastAfterSongs > 0
    && (podcastCount + 1) >= podcastAfterSongs;
}

async function planUpcomingAfterCurrentMusic() {
  if (isPodcastDueAfterCurrentMusic()) {
    try {
      return await peekNextPodcastEpisode();
    } catch (err) {
      console.warn('[engine] podcast preview for moderation failed:', err.message);
    }
  }
  return peekNextMusicItem();
}

async function validatePendingModerationPlan(plan) {
  if (!plan || !currentItem || currentItem.kind !== 'music') return { valid: true, upcoming: null };
  const currentKey = itemKey(currentItem);
  const upcoming = await planUpcomingAfterCurrentMusic();
  const freshUpcomingKey = moderationPlanKey(upcoming);
  const valid = plan.afterSongKey === currentKey && plan.upcomingKey === freshUpcomingKey;
  if (!valid) {
    console.log(`[engine] moderation pre-gen invalidated: after=${plan.afterSongKey === currentKey ? 'same' : 'changed'} upcoming=${plan.upcomingKey} -> ${freshUpcomingKey}`);
  }
  return { valid, upcoming };
}

async function generateModerationText(currentSong, nextItem = null, memoryContext = '') {
  try {
    const nextIsPodcast = nextItem?.kind === 'podcast';
    const system = moderatorSystemPrompt([
      'Schreibe eine kurze Uebergangsmoderation auf Deutsch.',
      'Moderiere den gelaufenen Song kurz ab und den naechsten Inhalt organisch an.',
      nextIsPodcast
        ? 'Wenn als Naechstes ein Podcast kommt, ist dies die einzige Podcast-Anmoderation vor dem Jingle. Fuehre Song-Abmoderation und Podcast-Anmoderation in einem zusammenhaengenden Text zusammen.'
        : 'Wenn als Naechstes Musik kommt, moderiere den gelaufenen Song kurz ab und den naechsten Song organisch an.',
      'Nutze Memory nur, wenn es wirklich organisch passt.',
    ].join(' '));
    const task   = [
      nextIsPodcast
        ? 'Schreibe eine zusammenhängende Übergangsmoderation (2-3 kurze Sätze). Sie ersetzt das separate Podcast-Intro vollständig.'
        : 'Schreibe eine kurze Übergangsmoderation (1-2 Sätze).',
      `Gerade lief: "${currentSong.artist} — ${currentSong.title}".`,
      describeUpcomingItem(nextItem),
      nextIsPodcast
        ? 'Erwähne den Podcast nur einmal. Kein zweites "jetzt geht es in..." am Ende. Danach kommt direkt der Podcast-Jingle.'
        : 'Moderiere den gelaufenen Song kurz ab und den nächsten Inhalt organisch an.',
      memoryContext,
      'Nutze Memory nur, wenn es wirklich organisch passt. Nicht jedes Mal sagen, dass du dich erinnerst.',
    ].filter(Boolean).join('\n\n');
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      // purpose flag routes to via-moderator (Hermes/Via) when PERSONAL_RADIO_USE_VIA=true
      purpose: 'radio-moderation',
      system,
      messages: [{ role: 'user', content: task }],
    });
    // Hermes can take up to 120s — this runs during the current song so latency is fine
    const res = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(110_000),
    });
    if (!res.ok) throw new Error(`claude-proxy HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const json = await res.json();
    const text = sanitizeModerationText(json?.content?.[0]?.text || '');
    if (!text) throw new Error('empty moderation response');
    return text;
  } catch(e) {
    console.warn('[engine] moderation text failed:', e.message);
    return null;
  }
}

async function ttsToTempFile(text) {
  mkdirSync(TMP_DIR, { recursive: true });
  const tmpFile = path.join(TMP_DIR, `mod-${Date.now()}.mp3`);
  try {
    text = sanitizeModerationText(text);
    if (!text) throw new Error('empty TTS text after sanitizing');
    const provider = engineSettings.ttsProvider === 'fish' ? 'fish' : 'elevenlabs';
    const isGerman = TTS_LANG === 'de';
    const url = provider === 'fish' ? TTS_FISH_URL : TTS_ELEVEN_URL;
    let payload;

    if (provider === 'fish') {
      const referenceId = isGerman
        ? (engineSettings.fishVoiceIdDe || engineSettings.fishVoiceIdEn)
        : (engineSettings.fishVoiceIdEn || engineSettings.fishVoiceIdDe);
      payload = {
        text,
        lang: TTS_LANG,
        ...(referenceId ? { reference_id: referenceId } : {}),
      };
    } else {
      const voiceId = isGerman
        ? (engineSettings.elevenLabsVoiceIdDe || engineSettings.elevenLabsVoiceIdEn)
        : (engineSettings.elevenLabsVoiceIdEn || engineSettings.elevenLabsVoiceIdDe);
      if (!voiceId) throw new Error('ElevenLabs selected but no voice ID configured');
      payload = {
        text,
        voice_id: voiceId,
        model_id: engineSettings.elevenLabsModelId || 'eleven_v3',
        voice_settings: engineSettings.elevenLabsVoiceSettings || DEFAULT_SETTINGS.elevenLabsVoiceSettings,
      };
    }

    console.log(`[engine] TTS provider: ${provider}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new Error(`TTS returned tiny response (${buf.length} bytes)`);
    writeFileSync(tmpFile, buf);
    await addTailSilenceToAudioFile(tmpFile);
    cleanupOldTtsFiles();
    const durationSeconds = await probeAudioDurationSeconds(tmpFile);
    console.log(`[engine] TTS file: ${tmpFile} (${buf.length} bytes${durationSeconds ? `, ${durationSeconds.toFixed(1)}s` : ''})`);
    return { file: tmpFile, durationSeconds };
  } catch(e) {
    console.warn('[engine] TTS failed:', e.message);
    try { unlinkSync(tmpFile); } catch {}
    return null;
  }
}

async function probeAudioDurationSeconds(file) {
  const result = await runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ], 5_000);
  const value = Number(String(result.stdout || '').trim());
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function addTailSilenceToAudioFile(file, seconds = TTS_FILE_TAIL_SILENCE_SECONDS) {
  const tailSeconds = Math.min(3, Math.max(0, Number(seconds || 0)));
  if (!tailSeconds) return file;
  const paddedFile = `${file}.padded.mp3`;
  const result = await runCommand('ffmpeg', [
    '-hide_banner',
    '-y',
    '-i', file,
    '-af', `apad=pad_dur=${tailSeconds}`,
    '-codec:a', 'libmp3lame',
    '-b:a', '128k',
    paddedFile,
  ], 20_000);
  if (!result.ok) {
    try { unlinkSync(paddedFile); } catch {}
    throw new Error(result.stderr || 'ffmpeg tail padding failed');
  }
  renameSync(paddedFile, file);
  return file;
}

function cleanupOldTtsFiles() {
  if (!Number.isFinite(TTS_KEEP_RECENT_FILES) || TTS_KEEP_RECENT_FILES <= 0) return;
  try {
    const files = readdirSync(TMP_DIR)
      .filter(name => /^mod-\d+\.mp3$/.test(name))
      .map(name => {
        const file = path.join(TMP_DIR, name);
        const stat = statSync(file);
        return { file, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const row of files.slice(TTS_KEEP_RECENT_FILES)) {
      try { unlinkSync(row.file); } catch {}
    }
  } catch {}
}

function maybeKeepTtsFile(file) {
  if (!file || !/\/mod-\d+\.mp3$/.test(file)) return false;
  cleanupOldTtsFiles();
  return true;
}

async function buildModerationItem(afterSong, nextItem = null) {
  console.log('[engine] generating moderation…');
  const compiled = memorySafe('music moderation context', () => buildMusicModerationContext(afterSong)) || { promptText: '', callInIds: [] };
  const text    = await generateModerationText(afterSong, nextItem, compiled.promptText);
  if (!text) return null;
  const tts = await ttsToTempFile(text);
  if (!tts?.file) return null;
  memorySafe('record music moderation', () => {
    recordModeration({ purpose: 'music-transition', item: afterSong, scriptText: text, context: { callInIds: compiled.callInIds, nextItem } });
    markCallInsUsed(compiled.callInIds, { purpose: 'music' });
  });
  return {
    kind: 'moderation',
    id: `mod-${Date.now()}`,
    title: 'Moderation',
    artist: 'Radio Host',
    artworkUrl: '',
    liveUrl: tts.file,
    duration: tts.durationSeconds || 0,
    tmpFile: tts.file,      // track temp file for cleanup
    scriptText: text,
    plannedNextKind: nextItem?.kind || 'music',
    coversPodcastIntro: nextItem?.kind === 'podcast',
    coveredPodcastIntroKey: nextItem?.kind === 'podcast' ? podcastEpisodeKey(nextItem) : null,
  };
}

// ── Multi-output playback ─────────────────────────────────────────────────────

/**
 * Play a URL/file on a single output sink.
 * Resolves when ffplay exits (naturally or killed).
 * Never rejects.
 */
function playbackAudioCacheKey(url) {
  return createHash('sha1').update(String(url || '')).digest('hex');
}

function cleanupOldPlaybackAudioCache() {
  const ttl = Number.isFinite(PLAYBACK_PREFETCH_TTL_MS) && PLAYBACK_PREFETCH_TTL_MS > 0 ? PLAYBACK_PREFETCH_TTL_MS : 2 * 60 * 60_000;
  try {
    const now = Date.now();
    for (const [key, row] of playbackAudioCache.entries()) {
      if (!row?.file || !existsSync(row.file) || now - Number(row.createdAt || 0) > ttl) {
        if (row?.file) { try { unlinkSync(row.file); } catch {} }
        playbackAudioCache.delete(key);
      }
    }
    for (const name of readdirSync(TMP_DIR)) {
      if (!/^play-prefetch-[a-f0-9]{40}-\d+\.mp3$/.test(name)) continue;
      const file = path.join(TMP_DIR, name);
      const stat = statSync(file);
      if (now - stat.mtimeMs > ttl) {
        try { unlinkSync(file); } catch {}
      }
    }
  } catch {}
}

async function downloadHttpAudioToFile(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error('download too small');
  writeFileSync(file, buf);
  return buf.length;
}

async function prefetchHttpAudioForStablePlayback(url, label = '') {
  if (!PLAYBACK_PREFETCH_ENABLED || !CACHE_HTTP_AUDIO) return null;
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  const key = playbackAudioCacheKey(url);
  const cached = playbackAudioCache.get(key);
  if (cached?.file && existsSync(cached.file)) return cached;
  if (playbackAudioPrefetches.has(key)) return playbackAudioPrefetches.get(key);

  const promise = (async () => {
    try {
      mkdirSync(TMP_DIR, { recursive: true });
      cleanupOldPlaybackAudioCache();
      const file = path.join(TMP_DIR, `play-prefetch-${key}-${Date.now()}.mp3`);
      const bytes = await downloadHttpAudioToFile(url, file);
      const row = { file, bytes, createdAt: Date.now() };
      playbackAudioCache.set(key, row);
      console.log(`[engine] prefetched audio for crossfade: ${label || url} -> ${file} (${bytes} bytes)`);
      return row;
    } catch (err) {
      console.warn(`[engine] audio prefetch failed for ${label || url}: ${err.message}`);
      return null;
    } finally {
      playbackAudioPrefetches.delete(key);
    }
  })();

  playbackAudioPrefetches.set(key, promise);
  return promise;
}

function prefetchUpcomingMusicForTransition(item) {
  if (item?.kind === 'music') {
    const upcoming = peekNextMusicItem();
    if (upcoming?.liveUrl) {
      void prefetchHttpAudioForStablePlayback(upcoming.liveUrl, `${upcoming.artist || ''} — ${upcoming.title || ''}`);
    }
  } else if (item?.kind === 'moderation' && item.plannedNextKind === 'music') {
    const upcoming = peekNextMusicItem();
    if (upcoming?.liveUrl) {
      void prefetchHttpAudioForStablePlayback(upcoming.liveUrl, `${upcoming.artist || ''} — ${upcoming.title || ''}`);
    }
  }
}

async function cacheHttpAudioForStablePlayback(url, options = {}) {
  if (!CACHE_HTTP_AUDIO || options.cacheHttpAudio !== true) return { playUrl: url, tmpFile: null };
  // Do not download full podcast episodes; segmented podcast playback uses -ss/-t.
  if (!/^https?:\/\//i.test(url)) return { playUrl: url, tmpFile: null };
  if (Number.isFinite(options.durationSeconds)) return { playUrl: url, tmpFile: null };

  try {
    mkdirSync(TMP_DIR, { recursive: true });
    const key = playbackAudioCacheKey(url);
    const prefetched = playbackAudioCache.get(key) || (playbackAudioPrefetches.has(key) ? await playbackAudioPrefetches.get(key) : null);
    if (prefetched?.file && existsSync(prefetched.file)) {
      console.log(`[engine] using prefetched audio for stable playback: ${prefetched.file}`);
      return { playUrl: prefetched.file, tmpFile: null };
    }
    const tmpFile = path.join(TMP_DIR, `play-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
    const bytes = await downloadHttpAudioToFile(url, tmpFile);
    console.log(`[engine] cached audio for stable playback: ${tmpFile} (${bytes} bytes)`);
    return { playUrl: tmpFile, tmpFile };
  } catch (err) {
    console.warn(`[engine] audio cache failed, streaming live: ${err.message}`);
    return { playUrl: url, tmpFile: null };
  }
}

async function playOnOutput(url, output, token, options = {}) {
  if (token.cancelled) {
    outputState[output.name].playing = false;
    return { output: output.name, code: -1, reason: 'cancelled' };
  }

  const sinks = await runCommand('pactl', ['list', 'short', 'sinks']);
  const hasSink = sinks.ok && sinks.stdout
    .split(/\r?\n/)
    .some(line => line.split(/\s+/)[1] === output.sink);
  if (!hasSink) {
    outputState[output.name].playing = false;
    outputState[output.name].pid = null;
    outputState[output.name].error = `sink unavailable: ${output.sink}`;
    console.warn(`[engine] output ${output.name} unavailable, not starting ffplay: ${output.sink}`);
    broadcastStatus();
    return { output: output.name, code: -1, reason: 'sink-unavailable' };
  }

  const { playUrl, tmpFile: playbackTmpFile } = await cacheHttpAudioForStablePlayback(url, options);
  if (token.cancelled) {
    if (playbackTmpFile) { try { unlinkSync(playbackTmpFile); } catch {} }
    outputState[output.name].playing = false;
    outputState[output.name].pid = null;
    return { output: output.name, code: -1, reason: 'cancelled' };
  }

  if (options.useOutroAnalysis
      && options.analysisItem?.kind === 'music'
      && Number.isFinite(options.fadeOutSeconds)
      && Number.isFinite(options.fadeOutStartSeconds)) {
    await analyzeTrackOutro(options.analysisItem, playUrl);
    if (token.cancelled) {
      if (playbackTmpFile) { try { unlinkSync(playbackTmpFile); } catch {} }
      outputState[output.name].playing = false;
      outputState[output.name].pid = null;
      return { output: output.name, code: -1, reason: 'cancelled' };
    }
    const transition = transitionStartFromAnalysis(options.analysisItem, options.fadeOutSeconds);
    options.fadeOutStartSeconds = transition.startSeconds;
    options.resolveEarlyAfterMs = Math.max(1000, transition.startSeconds * 1000);
    options.transitionDetail = transition.reason;
  }

  if (options.skipInitialSilence
      && options.analysisItem?.kind === 'music'
      && engineSettings.transitionIntroAnalysisEnabled !== false
      && (!Number.isFinite(options.startSeconds) || options.startSeconds <= 0)) {
    const analysis = await analyzeTrackOutro(options.analysisItem, playUrl);
    const audibleStart = Math.min(introSkipMaxSeconds(), Math.max(0, Number(analysis?.audibleStartSeconds || 0)));
    if (audibleStart > 0.05) {
      options.startSeconds = audibleStart;
      console.log(`[engine] transition intro trim: ${options.analysisItem.artist} — ${options.analysisItem.title} starts at ${audibleStart.toFixed(2)}s`);
    }
  }

  return new Promise(resolve => {
    const env = {
      ...process.env,
      PULSE_SINK: output.sink,
      PULSE_LATENCY_MSEC,
    };
    const args = [
      '-nodisp',
      '-autoexit',
      '-loglevel', 'warning',
      '-analyzeduration', FFPLAY_ANALYZE_DURATION,
      '-probesize', FFPLAY_PROBE_SIZE,
    ];
    const filters = [];
    if (FFPLAY_AUDIO_FILTER) filters.push(FFPLAY_AUDIO_FILTER);
    if (Number.isFinite(options.fadeInSeconds) && options.fadeInSeconds > 0) {
      filters.push(`afade=t=in:st=0:d=${Math.min(12, Math.max(0.2, options.fadeInSeconds))}`);
    }
    if (Number.isFinite(options.fadeOutStartSeconds) && options.fadeOutStartSeconds >= 0
        && Number.isFinite(options.fadeOutSeconds) && options.fadeOutSeconds > 0) {
      filters.push(`afade=t=out:st=${Math.max(0, options.fadeOutStartSeconds)}:d=${Math.min(12, Math.max(0.2, options.fadeOutSeconds))}`);
    }
    if (Number.isFinite(options.tailPadSeconds) && options.tailPadSeconds > 0) {
      filters.push(`apad=pad_dur=${Math.min(3, Math.max(0.1, options.tailPadSeconds))}`);
    }
    if (filters.length) args.push('-af', filters.join(','));
    if (Number.isFinite(options.startSeconds) && options.startSeconds > 0) {
      args.push('-ss', String(Math.max(0, options.startSeconds)));
    }
    if (Number.isFinite(options.durationSeconds) && options.durationSeconds > 0) {
      args.push('-t', String(Math.max(1, options.durationSeconds)));
    }
    args.push(playUrl);
    const proc = spawn('ffplay', args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      env,
    });
    const key = activeProcKey(output.name, proc);
    proc.__personalRadioOutput = output.name;
    let hardStop = null;
    let earlyResolve = null;
    let resolved = false;
    const finish = result => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };
    if (Number.isFinite(options.hardStopMs) && options.hardStopMs > 1000) {
      hardStop = setTimeout(() => {
        if (!proc.killed) {
          console.warn(`[engine] hard-stopping ffplay on ${output.name} after ${Math.round(options.hardStopMs / 1000)}s`);
          try { proc.kill('SIGTERM'); } catch {}
        }
      }, options.hardStopMs);
    }
    if (Number.isFinite(options.resolveEarlyAfterMs) && options.resolveEarlyAfterMs > 1000) {
      earlyResolve = setTimeout(() => {
        const reason = options.transitionReason || 'crossfade-overlap';
        const detail = options.transitionDetail ? ` (${options.transitionDetail})` : '';
        console.log(`[engine] ${reason}${detail} handoff on ${output.name}`);
        finish({ output: output.name, code: 0, reason });
      }, options.resolveEarlyAfterMs);
    }

    outputState[output.name].playing = true;
    outputState[output.name].pid     = proc.pid;
    outputState[output.name].error   = null;
    activeProcs.set(key, proc);

    proc.on('close', code => {
      if (hardStop) clearTimeout(hardStop);
      if (earlyResolve) clearTimeout(earlyResolve);
      if (playbackTmpFile) { try { unlinkSync(playbackTmpFile); } catch {} }
      activeProcs.delete(key);
      markOutputStoppedIfIdle(output.name);
      finish({ output: output.name, code, reason: 'close' });
    });

    proc.on('error', err => {
      if (hardStop) clearTimeout(hardStop);
      if (earlyResolve) clearTimeout(earlyResolve);
      if (playbackTmpFile) { try { unlinkSync(playbackTmpFile); } catch {} }
      activeProcs.delete(key);
      markOutputStoppedIfIdle(output.name);
      outputState[output.name].error   = err.message;
      console.error(`[engine] ffplay spawn error on ${output.name}: ${err.message}`);
      finish({ output: output.name, code: -1, reason: 'error' });
    });
  });
}

/**
 * Play an item on ALL configured outputs simultaneously.
 * Returns when all outputs have finished (or all are killed by skip/pause).
 */
async function playItemOnAllOutputs(item, options = {}) {
  const token = { cancelled: false };
  skipToken   = token;

  const playbackOptions = {
    ...options,
    cacheHttpAudio: options.cacheHttpAudio ?? item.kind === 'music',
    tailPadSeconds: options.tailPadSeconds ?? ((item.kind === 'moderation' || item.kind === 'tts') ? TTS_TAIL_PAD_SECONDS : 0),
  };
  const promises = OUTPUTS.map(o => playOnOutput(item.liveUrl, o, token, playbackOptions));
  broadcastStatus();

  const results = await Promise.allSettled(promises);
  const values = results.map(r => r.status === 'fulfilled' ? r.value : { output: 'unknown', code: -1, reason: 'rejected' });

  if (!options.allowOverlapTail) {
    // Clear any stragglers for ordinary playback. Crossfade deliberately leaves
    // the previous track alive for its fade-out tail.
    for (const proc of activeProcs.values()) {
      if (!proc.killed) try { proc.kill('SIGTERM'); } catch {}
      const outputName = proc.__personalRadioOutput;
      if (outputName) {
        outputState[outputName].playing = false;
        outputState[outputName].pid     = null;
      }
    }
    activeProcs.clear();
  }
  const startedSomeOutput = values.some(v => v?.code !== -1 || v?.reason === 'close');
  const allUnavailable = values.length > 0 && values.every(v => v?.reason === 'sink-unavailable' || v?.reason === 'cancelled');
  if (!startedSomeOutput && allUnavailable && engineSettings.autoSuspendWhenNoListeners !== false && !paused && playing) {
    const snapshot = await inspectActiveListeners();
    applyListenerSnapshot(snapshot);
    if (snapshot.activeListeners === 0) suspendForNoListeners(snapshot);
  }
  return values;
}

function killAll() {
  skipToken.cancelled = true;
  itemWasKilled       = true;
  nextMusicFadeInSeconds = 0;
  pendingModerationPlan = null;
  for (const proc of activeProcs.values()) {
    if (!proc.killed) try { proc.kill('SIGTERM'); } catch {}
    const outputName = proc.__personalRadioOutput;
    if (outputName) {
      outputState[outputName].playing = false;
      outputState[outputName].pid     = null;
    }
  }
  activeProcs.clear();
}

// ── Radio loop ────────────────────────────────────────────────────────────────

async function radioLoop() {
  console.log('[engine] radio loop starting');
  while (!shuttingDown) {
    if (paused) { await sleep(500); continue; }
    if (!(await ensureListenerBeforePlayback())) { await sleep(1000); continue; }

    if (queue.length === 0) {
      const ok = await refillQueue();
      if (!ok) { await sleep(10_000); continue; }
    }

    let nextItem = null;
    let resumeStartSeconds = 0;
    let resumedFromPause = false;
    let resumedAfterPodcastBreak = false;

    if (pausedResumeItem) {
      const resume = normalizeResumeSnapshot(pausedResumeItem, 'radio-loop');
      pausedResumeItem = null;
      if (resume) {
        nextItem = resume.item;
        resumeStartSeconds = Math.max(0, Number(resume.positionSeconds || 0));
        resumedFromPause = true;
        console.log(`[engine] resuming paused ${nextItem.kind}: ${nextItem.artist} — ${nextItem.title} at ${Math.round(resumeStartSeconds)}s`);
      }
    }

    if (!nextItem && forcedNextItem) {
      nextItem = forcedNextItem;
      forcedNextItem = null;
    }

    // ── Check pre-generated moderation ──────────────────────────────────────
    if (!nextItem && pendingModerationPromise !== null && !itemWasKilled) {
      const plan = pendingModerationPlan;
      // Wait up to 6s for pre-generated moderation (generation runs during prev song)
      let modItem = await Promise.race([
        pendingModerationPromise,
        sleep(6_000).then(() => null),
      ]);
      pendingModerationPromise = null;
      pendingModerationPlan = null;
      if (modItem) {
        const validation = await validatePendingModerationPlan(plan);
        if (!validation.valid) {
          if (modItem.tmpFile) { try { unlinkSync(modItem.tmpFile); } catch {} }
          modItem = currentItem?.kind === 'music'
            ? await buildModerationItem(currentItem, validation.upcoming)
            : null;
        }
        nextItem = modItem;
        if (nextItem) songCount = 0;
      }
    }
    pendingModerationPromise = null; // clear regardless (skipped or just-used)
    pendingModerationPlan = null;

    // ── Podcast resume after music break ──────────────────────────────────────
    if (!nextItem
        && engineSettings.podcastsEnabled !== false
        && podcastSessionActive
        && podcastBreakSongsRemaining <= 0) {
      const resumePodcast = currentPodcastResumeItem();
      if (resumePodcast) {
        nextItem = resumePodcast;
        resumedAfterPodcastBreak = true;
        podcastCount = 0;
        console.log(`[engine] podcast resume after music break: ${resumePodcast.artist} — ${resumePodcast.title}`);
      }
    }

    // ── Podcast injection ────────────────────────────────────────────────────
    const podcastAfterSongs = Number(engineSettings.podcastAfterSongs);
    if (!nextItem
        && engineSettings.podcastsEnabled !== false
        && podcastBreakSongsRemaining <= 0
        && Number.isFinite(podcastAfterSongs)
        && podcastCount >= podcastAfterSongs
        && podcastAfterSongs > 0) {
      try {
        nextItem = await nextPodcastEpisode();
        podcastCount = 0;
      } catch(e) {
        console.warn('[engine] podcast fetch failed:', e.message);
        podcastCount = 0;
      }
    }

    // ── Music pick ───────────────────────────────────────────────────────────
    if (!nextItem) {
      const idx = queue.findIndex(t => !isBlocked(t));
      if (idx === -1) { queue = []; continue; }
      nextItem = queue.splice(idx, 1)[0];
    }

    // ── Play ─────────────────────────────────────────────────────────────────
    currentItem   = nextItem;
    startedAt     = Date.now();
    currentPlaybackStartSeconds = resumeStartSeconds;
    playing       = true;
    paused        = false;
    itemWasKilled = false;

    console.log(`[engine] PLAY [${nextItem.kind}] ${nextItem.artist} — ${nextItem.title}`);
    if (nextItem.kind === 'music') {
      prefetchAudioAnalysis([nextItem, ...queue]);
      memorySafe('record track started', () => {
        recordTrackStarted(nextItem);
        rememberRecentTrack(nextItem, { event: 'started' });
      });
      if (sessionIntroRequest && pendingSessionIntroPromise === null) {
        const request = { ...sessionIntroRequest };
        const starterSong = { ...nextItem };
        sessionIntroSongKey = itemKey(nextItem);
        pendingSessionIntroPromise = buildSessionIntroItem(request, starterSong)
          .then(item => { if (item) console.log('[engine] session intro pre-generated, ready'); return item; })
          .catch(err => { console.warn('[engine] session intro pre-gen error:', err.message); return null; });
      }
    }
    broadcastStatus();

    // Pre-generate moderation in background during this song if it will be the
    // Nth music track. Only starts once — not restarted on partial completion.
    const moderationAfterSongs = Number(engineSettings.moderationAfterSongs);
    if (nextItem.kind === 'music'
        && !sessionIntroRequest
        && engineSettings.moderationEnabled
        && moderationAfterSongs > 0
        && Number.isFinite(moderationAfterSongs)
        && (songCount + 1) >= moderationAfterSongs
        && pendingModerationPromise === null) {
      const songForMod = nextItem;
      const upcomingPromise = planUpcomingAfterCurrentMusic();
      pendingModerationPromise = upcomingPromise
        .then(upcoming => {
          pendingModerationPlan = {
            afterSongKey: itemKey(songForMod),
            upcomingKey: moderationPlanKey(upcoming),
          };
          if (upcoming?.kind === 'podcast') {
            prefetchPodcastSegment(upcoming);
          }
          return buildModerationItem(songForMod, upcoming);
        })
        .then(item => { if (item) console.log('[engine] moderation pre-generated, ready'); return item; })
        .catch(err  => { console.warn('[engine] moderation pre-gen error:', err.message); return null; });
    }

    if (nextItem.kind === 'music'
        && !sessionIntroRequest
        && pendingPodcastIntroPromise === null
        && !moderationDueAfterCurrentMusic()
        && isPodcastDueAfterCurrentMusic()) {
      planUpcomingAfterCurrentMusic()
        .then(upcoming => {
          if (upcoming?.kind !== 'podcast' || pendingPodcastIntroPromise !== null) return null;
          const { state } = getEpisodeState(upcoming);
          const key = podcastEpisodeKey(upcoming);
          const isResume = Number(state.positionSeconds || 0) > 60 || Number(state.part || 1) > 1;
          pendingPodcastIntroKey = key;
          pendingPodcastIntroPromise = buildPodcastIntroItem(upcoming, state, isResume)
            .then(item => { if (item) console.log('[engine] podcast intro pre-generated, ready'); return item; })
            .catch(err => { console.warn('[engine] podcast intro pre-gen error:', err.message); return null; });
          prefetchPodcastSegment(upcoming);
          return null;
        })
        .catch(err => console.warn('[engine] podcast intro preview failed:', err.message));
    }

    let podcastSegmentResult = null;
    if (nextItem.kind === 'podcast') {
      if (resumedAfterPodcastBreak) {
        const { state } = getEpisodeState(nextItem);
        const returnItem = await buildPodcastReturnItem(state);
        if (returnItem && !paused && !shuttingDown) {
          currentItem = returnItem;
          startedAt = Date.now();
          currentPlaybackStartSeconds = 0;
          playing = true;
          itemWasKilled = false;
          console.log(`[engine] PLAY [${returnItem.kind}] ${returnItem.artist} — ${returnItem.title}`);
          broadcastStatus();
          await playItemOnAllOutputs(returnItem);
          if (returnItem.tmpFile && !maybeKeepTtsFile(returnItem.tmpFile)) { try { unlinkSync(returnItem.tmpFile); } catch {} }
          console.log(`[engine] DONE [${returnItem.kind}] ${returnItem.artist} — ${returnItem.title} (killed=${itemWasKilled})`);
        }
      } else if (!resumedFromPause) {
        const { state } = getEpisodeState(nextItem);
        const isResume = Number(state.positionSeconds || 0) > 60 || Number(state.part || 1) > 1;
        const key = podcastEpisodeKey(nextItem);
        let introItem = null;
        const introCovered = !isResume && coveredPodcastIntroKey === key;
        if (coveredPodcastIntroKey && coveredPodcastIntroKey !== key) coveredPodcastIntroKey = null;
        if (introCovered) {
          console.log(`[engine] skipping podcast intro; covered by transition moderation: ${key}`);
          if (pendingPodcastIntroPromise && pendingPodcastIntroKey === key) {
            pendingPodcastIntroPromise.then(item => {
              if (item?.tmpFile && !maybeKeepTtsFile(item.tmpFile)) { try { unlinkSync(item.tmpFile); } catch {} }
            }).catch(() => {});
          }
          pendingPodcastIntroPromise = null;
          pendingPodcastIntroKey = null;
          coveredPodcastIntroKey = null;
        } else if (pendingPodcastIntroPromise && pendingPodcastIntroKey === key) {
          introItem = await Promise.race([
            pendingPodcastIntroPromise,
            sleep(2_000).then(() => null),
          ]);
          pendingPodcastIntroPromise = null;
          pendingPodcastIntroKey = null;
        } else {
          pendingPodcastIntroPromise = null;
          pendingPodcastIntroKey = null;
        }
        if (!introCovered && !introItem) introItem = await buildPodcastIntroItem(nextItem, state, isResume);
        if (introItem && !paused && !shuttingDown) {
          currentItem = introItem;
          startedAt = Date.now();
          currentPlaybackStartSeconds = 0;
          playing = true;
          itemWasKilled = false;
          console.log(`[engine] PLAY [${introItem.kind}] ${introItem.artist} — ${introItem.title}`);
          broadcastStatus();
          await playItemOnAllOutputs(introItem);
          if (introItem.tmpFile && !maybeKeepTtsFile(introItem.tmpFile)) { try { unlinkSync(introItem.tmpFile); } catch {} }
          console.log(`[engine] DONE [${introItem.kind}] ${introItem.artist} — ${introItem.title} (killed=${itemWasKilled})`);
        }
        const jingleItem = buildJingleItem(PODCAST_INTRO_JINGLE, 'Podcast Intro Jingle');
        if (jingleItem && !paused && !shuttingDown) {
          currentItem = jingleItem;
          startedAt = Date.now();
          currentPlaybackStartSeconds = 0;
          playing = true;
          itemWasKilled = false;
          console.log(`[engine] PLAY [${jingleItem.kind}] ${jingleItem.artist} — ${jingleItem.title}`);
          broadcastStatus();
          await playItemOnAllOutputs(jingleItem);
          console.log(`[engine] DONE [${jingleItem.kind}] ${jingleItem.artist} — ${jingleItem.title} (killed=${itemWasKilled})`);
        }
      }
      currentItem = nextItem;
      startedAt = Date.now();
      currentPlaybackStartSeconds = Math.max(0, Number(getEpisodeState(nextItem).state.positionSeconds || 0));
      playing = true;
      itemWasKilled = false;
      broadcastStatus();
      podcastSegmentResult = await playPodcastSegment(nextItem);
    } else {
      const playOptions = resumeStartSeconds > 0 ? { startSeconds: resumeStartSeconds } : {};
      if (nextItem.kind === 'music') {
        if (nextMusicFadeInSeconds > 0) {
          playOptions.fadeInSeconds = nextMusicFadeInSeconds;
          playOptions.skipInitialSilence = true;
          playOptions.analysisItem = nextItem;
          nextMusicFadeInSeconds = 0;
        }
        Object.assign(playOptions, musicCrossfadeOptions(nextItem, resumeStartSeconds));
        if (playOptions.resolveEarlyAfterMs) prefetchUpcomingMusicForTransition(nextItem);
      } else if (nextItem.kind === 'moderation') {
        Object.assign(playOptions, moderationToMusicOptions(nextItem));
        if (playOptions.resolveEarlyAfterMs) prefetchUpcomingMusicForTransition(nextItem);
      } else {
        nextMusicFadeInSeconds = 0;
      }
      const playResults = await playItemOnAllOutputs(nextItem, playOptions);
      if (nextItem.kind === 'music' && playResults.some(result => result?.reason === 'music-crossfade')) {
        nextMusicFadeInSeconds = crossfadeSeconds();
        console.log(`[engine] crossfade overlap armed for next music (${nextMusicFadeInSeconds}s)`);
      } else if (nextItem.kind === 'moderation' && playResults.some(result => result?.reason === 'moderation-to-music-duck')) {
        nextMusicFadeInSeconds = Number(playOptions.nextMusicFadeInSeconds || moderationDuckSeconds());
        console.log(`[engine] moderation ducking armed for next music (${nextMusicFadeInSeconds}s)`);
      }
      if (nextItem.kind === 'moderation' && nextItem.coversPodcastIntro && nextItem.coveredPodcastIntroKey && !itemWasKilled) {
        coveredPodcastIntroKey = nextItem.coveredPodcastIntroKey;
        console.log(`[engine] podcast intro covered by transition moderation: ${coveredPodcastIntroKey}`);
      }
    }

    // Keep recent TTS temp files for debugging clipped moderation endings.
    if (nextItem.tmpFile && !maybeKeepTtsFile(nextItem.tmpFile)) { try { unlinkSync(nextItem.tmpFile); } catch {} }

    console.log(`[engine] DONE [${nextItem.kind}] ${nextItem.artist} — ${nextItem.title} (killed=${itemWasKilled})`);
    if (nextItem.kind === 'music') {
      memorySafe('record track finished', () => {
        recordTrackFinished(nextItem, {
          natural: !itemWasKilled,
          elapsedSeconds: playbackPositionSeconds(),
        });
        rememberRecentTrack(nextItem, { event: itemWasKilled ? 'killed' : 'finished' });
      });
    }
    playing = false;

    if (nextItem.kind === 'music'
        && !itemWasKilled
        && sessionIntroRequest
        && sessionIntroSongKey === itemKey(nextItem)
        && !paused
        && !shuttingDown) {
      const introItem = await Promise.race([
        pendingSessionIntroPromise,
        sleep(12_000).then(() => null),
      ]);
      pendingSessionIntroPromise = null;
      sessionIntroSongKey = null;
      const hadDeferredResume = !!deferredResumeItem;
      sessionIntroRequest = null;
      if (introItem && !paused && !shuttingDown) {
        currentItem = introItem;
        startedAt = Date.now();
        currentPlaybackStartSeconds = 0;
        playing = true;
        itemWasKilled = false;
        console.log(`[engine] PLAY [${introItem.kind}] ${introItem.artist} — ${introItem.title}`);
        broadcastStatus();
        const introOptions = moderationToMusicOptions(introItem);
        if (introOptions.resolveEarlyAfterMs) prefetchUpcomingMusicForTransition(introItem);
        const introResults = await playItemOnAllOutputs(introItem, introOptions);
        if (introResults.some(result => result?.reason === 'moderation-to-music-duck')) {
          nextMusicFadeInSeconds = Number(introOptions.nextMusicFadeInSeconds || moderationDuckSeconds());
          console.log(`[engine] session intro ducking armed for next music (${nextMusicFadeInSeconds}s)`);
        }
        if (introItem.tmpFile && !maybeKeepTtsFile(introItem.tmpFile)) { try { unlinkSync(introItem.tmpFile); } catch {} }
        console.log(`[engine] DONE [${introItem.kind}] ${introItem.artist} — ${introItem.title} (killed=${itemWasKilled})`);
        playing = false;
      } else {
        console.warn('[engine] session intro not ready after starter song; continuing radio');
      }
      if (hadDeferredResume && deferredResumeItem && !paused && !shuttingDown) {
        pausedResumeItem = deferredResumeItem;
        deferredResumeItem = null;
        console.log(`[engine] deferred ${pausedResumeItem.item.kind} resume queued after session intro`);
      }
    }

    if (nextItem.kind === 'podcast' && podcastSegmentResult?.shouldModerate && !paused) {
      const returnJingle = buildJingleItem(PODCAST_RETURN_JINGLE, 'Studio Return Jingle');
      if (returnJingle && !paused && !shuttingDown) {
        currentItem = returnJingle;
        startedAt = Date.now();
        currentPlaybackStartSeconds = 0;
        playing = true;
        itemWasKilled = false;
        console.log(`[engine] PLAY [${returnJingle.kind}] ${returnJingle.artist} — ${returnJingle.title}`);
        broadcastStatus();
        await playItemOnAllOutputs(returnJingle);
        console.log(`[engine] DONE [${returnJingle.kind}] ${returnJingle.artist} — ${returnJingle.title} (killed=${itemWasKilled})`);
      }
      const modItem = await buildPodcastModerationItem(
        nextItem,
        podcastSegmentResult.state,
        podcastSegmentResult.segment,
        podcastSegmentResult.context,
      );
      if (modItem) {
        currentItem = modItem;
        startedAt = Date.now();
        playing = true;
        itemWasKilled = false;
        console.log(`[engine] PLAY [${modItem.kind}] ${modItem.artist} — ${modItem.title}`);
        broadcastStatus();
        const modOptions = moderationToMusicOptions(modItem);
        if (modOptions.resolveEarlyAfterMs) prefetchUpcomingMusicForTransition(modItem);
        const modResults = await playItemOnAllOutputs(modItem, modOptions);
        if (modResults.some(result => result?.reason === 'moderation-to-music-duck')) {
          nextMusicFadeInSeconds = Number(modOptions.nextMusicFadeInSeconds || moderationDuckSeconds());
          console.log(`[engine] podcast moderation ducking armed for next music (${nextMusicFadeInSeconds}s)`);
        }
        if (modItem.tmpFile && !maybeKeepTtsFile(modItem.tmpFile)) { try { unlinkSync(modItem.tmpFile); } catch {} }
        console.log(`[engine] DONE [${modItem.kind}] ${modItem.artist} — ${modItem.title} (killed=${itemWasKilled})`);
        playing = false;
      }
      podcastBreakSongsRemaining = choosePodcastBreakSongs();
      podcastState.breakSongsRemaining = podcastBreakSongsRemaining;
      savePodcastState();
      console.log(`[engine] podcast music break: ${podcastBreakSongsRemaining} track(s) before resume`);
    }

    // Only count natural completions — not skips/bans/pauses
    if (nextItem.kind === 'music' && !itemWasKilled) {
      songCount++;
      podcastCount++;
      if (podcastBreakSongsRemaining > 0) {
        podcastBreakSongsRemaining--;
        podcastState.breakSongsRemaining = podcastBreakSongsRemaining;
        savePodcastState();
      }
    }

    if (!paused && !shuttingDown) broadcastStatus();
    await sleep(500);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP server ───────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...CORS });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await collectBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function runCommand(cmd, args, timeoutMs = 0) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        finish({ ok: false, stdout, stderr: `${stderr}\ncommand timed out after ${timeoutMs}ms`.trim() });
      }, timeoutMs);
    }
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', err => finish({ ok: false, stdout, stderr: err.message }));
    child.on('close', code => finish({ ok: code === 0, stdout, stderr }));
  });
}

async function getOutputVolumes() {
  const out = {};
  for (const output of OUTPUTS) {
    const volumeRes = await runCommand('pactl', ['get-sink-volume', output.sink]);
    const muteRes = await runCommand('pactl', ['get-sink-mute', output.sink]);
    const match = volumeRes.stdout.match(/(\d+)%/);
    out[output.name] = {
      sink: output.sink,
      volume: match ? Math.max(0, Math.min(1.5, Number(match[1]) / 100)) : null,
      muted: /yes/i.test(muteRes.stdout),
      error: volumeRes.ok ? null : (volumeRes.stderr || 'pactl get-sink-volume failed').trim(),
    };
  }
  return out;
}

async function setOutputVolume(outputName, volume) {
  const output = OUTPUTS.find(o => o.name === outputName);
  if (!output) throw new Error(`Unknown output: ${outputName}`);
  const clamped = Math.max(0, Math.min(1.5, Number(volume)));
  const percent = `${Math.round(clamped * 100)}%`;
  const result = await runCommand('pactl', ['set-sink-volume', output.sink, percent]);
  if (!result.ok) throw new Error((result.stderr || `pactl failed for ${outputName}`).trim());
}

function isStreamOutput(output) {
  return /stream/i.test(output.name || '') || /personal_radio_stream/i.test(output.sink || '');
}

function streamListenerMaxAgeMinutes() {
  const minutes = Number(engineSettings.streamListenerMaxAgeMinutes ?? 180);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 180;
}

async function fetchLiveStreamStatus() {
  try {
    const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/live-stream/status`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    return { ok: false, clients: 0, error: err.message };
  }
}

async function inspectActiveListeners() {
  const sinkRes = await runCommand('pactl', ['list', 'short', 'sinks'], 3_000);
  const sinkNames = new Set(
    sinkRes.ok
      ? sinkRes.stdout.split(/\r?\n/).map(line => line.split(/\s+/)[1]).filter(Boolean)
      : []
  );
  const hasStreamOutput = OUTPUTS.some(isStreamOutput);
  const liveStatus = hasStreamOutput ? await fetchLiveStreamStatus() : null;
  const streamMaxAgeSeconds = Math.max(60, streamListenerMaxAgeMinutes() * 60);
  const details = OUTPUTS.map(output => {
    const sinkAvailable = sinkNames.has(output.sink);
    if (isStreamOutput(output)) {
      const clients = Number(liveStatus?.clients || 0);
      const clientDetails = Array.isArray(liveStatus?.clientDetails) ? liveStatus.clientDetails : [];
      const freshClients = clientDetails.length > 0
        ? clientDetails.filter(client => client.listener !== false && Number(client.ageSeconds || 0) <= streamMaxAgeSeconds).length
        : clients;
      return {
        name: output.name,
        sink: output.sink,
        kind: 'stream',
        sinkAvailable,
        clients,
        freshClients,
        maxClientAgeSeconds: streamMaxAgeSeconds,
        active: sinkAvailable && freshClients > 0,
        reason: sinkAvailable
          ? freshClients > 0 ? 'stream-client' : clients > 0 ? 'stale-stream-clients' : 'no-stream-clients'
          : 'sink-unavailable',
      };
    }
    return {
      name: output.name,
      sink: output.sink,
      kind: 'physical',
      sinkAvailable,
      active: sinkAvailable,
      reason: sinkAvailable ? 'sink-available' : 'sink-unavailable',
    };
  });
  const activeOutputs = details.filter(d => d.active).map(d => d.name);
  return {
    checkedAt: new Date().toISOString(),
    activeListeners: activeOutputs.length,
    activeOutputs,
    outputDetails: details,
    liveStreamClients: hasStreamOutput ? Number(liveStatus?.clients || 0) : null,
    freshLiveStreamClients: hasStreamOutput
      ? details.filter(d => d.kind === 'stream').reduce((sum, d) => sum + Number(d.freshClients || 0), 0)
      : null,
    liveStreamStatus: liveStatus,
  };
}

function applyListenerSnapshot(snapshot) {
  listenerState.lastCheckedAt = snapshot.checkedAt;
  listenerState.activeListeners = snapshot.activeListeners;
  listenerState.activeOutputs = snapshot.activeOutputs;
  listenerState.outputDetails = snapshot.outputDetails;
  listenerState.liveStreamClients = snapshot.liveStreamClients;
  listenerState.freshLiveStreamClients = snapshot.freshLiveStreamClients;

  if (snapshot.activeListeners > 0) {
    listenerState.lastHeardAt = snapshot.checkedAt;
    listenerState.silenceDurationSeconds = 0;
    if (listenerState.mode !== 'suspended') {
      manualStartGraceUntil = 0;
      manualStartGraceReason = null;
      listenerState.mode = 'active';
      listenerState.reason = null;
      listenerState.graceStartedAt = null;
      listenerState.resumeWillStartNewSession = false;
    }
    return;
  }

  if (listenerState.mode === 'suspended') {
    const suspendedAtMs = listenerState.suspendedAt ? Date.parse(listenerState.suspendedAt) : Date.now();
    listenerState.silenceDurationSeconds = Math.max(0, Math.floor((Date.now() - suspendedAtMs) / 1000));
    listenerState.resumeWillStartNewSession = listenerState.silenceDurationSeconds >= Math.max(60, Number(engineSettings.newSessionAfterMinutes ?? 180) * 60);
    return;
  }

  if (listenerState.mode !== 'grace') {
    listenerState.mode = 'grace';
    listenerState.graceStartedAt = snapshot.checkedAt;
    listenerState.reason = 'no-active-listeners';
    listenerState.silenceDurationSeconds = 0;
  } else {
    const startedMs = listenerState.graceStartedAt ? Date.parse(listenerState.graceStartedAt) : Date.now();
    listenerState.silenceDurationSeconds = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
  }
}

function formatDurationGerman(seconds) {
  const s = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours} Stunden und ${minutes} Minuten`;
  if (hours > 0) return `${hours} Stunden`;
  if (minutes > 0) return `${minutes} Minuten`;
  return `${s} Sekunden`;
}

function itemKey(item) {
  if (!item) return '';
  return item.id || item.liveUrl || `${item.artist || ''}::${item.title || ''}`;
}

async function pickSessionStarterSong() {
  if (engineSettings.resumeWithLikedSong === false) return null;
  const liked = shuffle((await fetchLikedTracks()).filter(t => !isBlocked(t)));
  if (liked.length > 0) return { ...liked[0], sessionStarter: true };
  return null;
}

async function generateSessionIntroText(request, starterSong, callIns = []) {
  try {
    const memory = memorySafe('load memory for session intro', () => loadMemory()) || {};
    const today = memory.dailyMemory?.[new Date().toISOString().slice(0, 10)] || null;
    const recentPodcast = (memory.podcastSegments || [])[0];
    const system = moderatorSystemPrompt([
      'Erzeuge eine kurze Anmoderation fuer eine neue Radio-Session.',
      'Die Session startet nach laengerer Stille zuerst mit Musik, danach sprichst du.',
      'Wenn Kontext unsicher ist, bleib ehrlich und knapp.',
    ].join(' '));
    const task = [
      `Das Radio stand still für: ${formatDurationGerman(request.suspendedSeconds)}.`,
      `Erster Song nach der Rückkehr: ${starterSong?.artist || 'Unbekannt'} — ${starterSong?.title || 'Unbekannt'}.`,
      request.deferredResumeKind === 'podcast' ? 'Ein Podcast wurde pausiert und kann nach der Begrüßung fortgesetzt werden.' : '',
      today?.podcastTopics?.length ? `Heutige Podcast-Themen bisher: ${today.podcastTopics.slice(0, 8).join(', ')}.` : '',
      recentPodcast ? `Letzter Podcast-Kontext: ${recentPodcast.showTitle || ''} — ${recentPodcast.episodeTitle || ''}; Themen: ${(recentPodcast.topics || []).slice(0, 6).join(', ')}.` : '',
      callIns.length ? `Offene Call-Ins:\n${callIns.map(c => `- ${c.text}${c.mood ? ` (Stimmung: ${c.mood})` : ''}`).join('\n')}` : '',
      '',
      'Schreibe 2 kurze Sätze. Begrüße zurück, ohne dramatisch zu sein. Erwähne die Pause nur, wenn es natürlich klingt.',
    ].filter(Boolean).join('\n');
    const res = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        purpose: 'radio-moderation',
        system,
        messages: [{ role: 'user', content: task }],
      }),
      signal: AbortSignal.timeout(110_000),
    });
    if (!res.ok) throw new Error(`claude-proxy HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const json = await res.json();
    const text = sanitizeModerationText(json?.content?.[0]?.text || '');
    return text || null;
  } catch (err) {
    console.warn('[engine] session intro text failed:', err.message);
    return null;
  }
}

async function buildSessionIntroItem(request, starterSong) {
  console.log('[engine] generating session intro…');
  const callIns = memorySafe('list call-ins for session intro', () => listCallIns({ status: 'open', limit: 3 })) || [];
  const text = sanitizeModerationText(await generateSessionIntroText(request, starterSong, callIns));
  const fallback = `Willkommen zurück. Das Radio stand etwa ${formatDurationGerman(request.suspendedSeconds)} still; jetzt holen wir den Faden wieder auf.`;
  const scriptText = text || fallback;
  const tts = await ttsToTempFile(scriptText);
  if (!tts?.file) return null;
  memorySafe('record session intro moderation', () => {
    recordModeration({
      purpose: 'session-intro',
      item: starterSong,
      scriptText,
      context: {
        suspendedSeconds: request.suspendedSeconds,
        callInIds: callIns.map(c => c.id),
      },
    });
    markCallInsUsed(callIns.map(c => c.id), { purpose: 'session-intro' });
  });
  return {
    kind: 'moderation',
    id: `session-intro-${Date.now()}`,
    title: 'Session Intro',
    artist: 'Radio Host',
    artworkUrl: starterSong?.artworkUrl || '',
    liveUrl: tts.file,
    duration: tts.durationSeconds || 0,
    tmpFile: tts.file,
    scriptText,
    plannedNextKind: request.deferredResumeKind || 'music',
  };
}

function clearPendingPlaybackPlans() {
  pausedResumeItem = null;
  deferredResumeItem = null;
  pendingModerationPromise = null;
  pendingModerationPlan = null;
  pendingPodcastIntroPromise = null;
  pendingPodcastIntroKey = null;
  clearPendingPodcastSegmentPrefetch();
  pendingSessionIntroPromise = null;
  sessionIntroSongKey = null;
  coveredPodcastIntroKey = null;
}

async function startFreshRadioSession(reason = 'manual') {
  const nowIso = new Date().toISOString();
  clearPendingPlaybackPlans();
  killAll();

  currentItem = null;
  startedAt = null;
  currentPlaybackStartSeconds = 0;
  playing = false;
  paused = false;
  itemWasKilled = true;
  forcedNextItem = null;
  nextMusicFadeInSeconds = 0;
  songCount = 0;
  podcastCount = 0;
  podcastBreakSongsRemaining = 0;
  podcastSessionActive = false;
  podcastState.breakSongsRemaining = 0;
  savePodcastState();

  let starter = await pickSessionStarterSong();
  if (!starter) {
    if (queue.length === 0) await refillQueue();
    const idx = queue.findIndex(t => !isBlocked(t));
    if (idx >= 0) starter = queue.splice(idx, 1)[0];
  } else {
    queue = queue.filter(t => itemKey(t) !== itemKey(starter));
  }
  if (starter) forcedNextItem = { ...starter, sessionStarter: true };

  sessionIntroRequest = {
    suspendedAt: listenerState.suspendedAt,
    resumedAt: nowIso,
    suspendedSeconds: listenerState.silenceDurationSeconds || 0,
    deferredResumeKind: null,
    freshStart: true,
    reason,
  };

  listenerState.mode = 'active';
  listenerState.lastResumedAt = nowIso;
  listenerState.lastSuspendDurationSeconds = 0;
  listenerState.silenceDurationSeconds = 0;
  listenerState.resumeWillStartNewSession = false;
  listenerState.reason = null;

  console.log(`[engine] fresh radio session requested (${reason})${starter ? ` with starter: ${starter.artist} — ${starter.title}` : ''}`);
  broadcastStatus();
  return starter;
}

function suspendForNoListeners(snapshot) {
  if (engineSettings.autoSuspendWhenNoListeners === false) return;
  if (paused || !playing || !currentItem) return;

  const saved = snapshotCurrentForPause();
  if (saved?.item?.kind === 'podcast' || saved?.item?.kind === 'music') {
    pausedResumeItem = saved;
    persistPodcastPausePosition(saved);
  } else {
    pausedResumeItem = null;
  }
  pendingModerationPromise = null;
  pendingModerationPlan = null;
  pendingPodcastIntroPromise = null;
  pendingPodcastIntroKey = null;
  pendingSessionIntroPromise = null;
  sessionIntroSongKey = null;
  paused = true;
  playing = false;
  listenerState.mode = 'suspended';
  listenerState.suspendedAt = snapshot.checkedAt;
  listenerState.graceStartedAt = null;
  listenerState.reason = 'no-active-listeners';
  listenerState.silenceDurationSeconds = 0;
  listenerState.resumeWillStartNewSession = false;
  console.warn(`[engine] auto-suspend: no active listeners for ${engineSettings.noListenerGraceSeconds ?? 30}s; saved ${saved?.item?.kind || 'nothing'} at ${Math.round(saved?.positionSeconds || 0)}s`);
  killAll();
  broadcastStatus();
}

function armManualStartGrace(reason = 'manual-play') {
  manualStartGraceUntil = Date.now() + MANUAL_START_GRACE_MS;
  manualStartGraceReason = reason;
}

async function ensureListenerBeforePlayback() {
  if (engineSettings.autoSuspendWhenNoListeners === false) return true;
  const snapshot = await inspectActiveListeners();
  applyListenerSnapshot(snapshot);
  if (snapshot.activeListeners > 0) return true;

  const manualStartGraceRemainingMs = manualStartGraceUntil - Date.now();
  if (manualStartGraceRemainingMs > 0) {
    listenerState.mode = 'starting';
    listenerState.graceStartedAt = snapshot.checkedAt;
    listenerState.reason = 'manual-start-grace';
    listenerState.silenceDurationSeconds = 0;
    console.warn(
      `[engine] manual start grace: starting without confirmed listener for ${Math.ceil(manualStartGraceRemainingMs / 1000)}s (${manualStartGraceReason || 'manual-play'})`
    );
    broadcastStatus();
    return true;
  }

  manualStartGraceUntil = 0;
  manualStartGraceReason = null;
  paused = true;
  playing = false;
  listenerState.mode = 'suspended';
  listenerState.suspendedAt = listenerState.suspendedAt || snapshot.checkedAt;
  listenerState.graceStartedAt = null;
  listenerState.reason = 'no-active-listeners';
  console.warn('[engine] auto-suspend: no active listeners before playback; waiting for an output/client');
  broadcastStatus();
  return false;
}

async function resumeFromListenerReturn(snapshot) {
  if (listenerResumeInProgress || listenerState.mode !== 'suspended') return;
  listenerResumeInProgress = true;
  try {
    const nowIso = snapshot.checkedAt;
    const suspendedAtMs = listenerState.suspendedAt ? Date.parse(listenerState.suspendedAt) : Date.now();
    const suspendedSeconds = Math.max(0, Math.floor((Date.now() - suspendedAtMs) / 1000));
    const thresholdSeconds = Math.max(60, Number(engineSettings.newSessionAfterMinutes ?? 180) * 60);
    const startsNewSession = suspendedSeconds >= thresholdSeconds;

    listenerState.mode = 'active';
    listenerState.lastResumedAt = nowIso;
    listenerState.lastSuspendDurationSeconds = suspendedSeconds;
    listenerState.silenceDurationSeconds = 0;
    listenerState.resumeWillStartNewSession = startsNewSession;
    listenerState.reason = null;

    if (startsNewSession && engineSettings.sessionIntroAfterFirstSong !== false) {
      const saved = pausedResumeItem;
      deferredResumeItem = saved?.item?.kind === 'podcast' ? saved : null;
      pausedResumeItem = null;
      const starter = await pickSessionStarterSong();
      if (starter) {
        forcedNextItem = starter;
        queue = queue.filter(t => itemKey(t) !== itemKey(starter));
      }
      sessionIntroRequest = {
        suspendedAt: listenerState.suspendedAt,
        resumedAt: nowIso,
        suspendedSeconds,
        deferredResumeKind: deferredResumeItem?.item?.kind || null,
      };
      console.log(`[engine] listener returned after ${formatDurationGerman(suspendedSeconds)}; starting new session${starter ? ` with liked song: ${starter.artist} — ${starter.title}` : ''}`);
    } else {
      console.log(`[engine] listener returned after ${formatDurationGerman(suspendedSeconds)}; resuming paused radio`);
    }

    paused = false;
    broadcastStatus();
  } finally {
    listenerResumeInProgress = false;
  }
}

async function listenerMonitorLoop() {
  while (!shuttingDown) {
    try {
      if (engineSettings.autoSuspendWhenNoListeners === false) {
        listenerState.mode = 'disabled';
        await sleep(5_000);
        continue;
      }
      const snapshot = await inspectActiveListeners();
      const previousMode = listenerState.mode;
      applyListenerSnapshot(snapshot);
      if (previousMode === 'suspended' && snapshot.activeListeners > 0) {
        await resumeFromListenerReturn(snapshot);
      } else if (listenerState.mode === 'grace' && playing && !paused) {
        const graceSeconds = Math.max(0, Number(engineSettings.noListenerGraceSeconds ?? 30));
        if (listenerState.silenceDurationSeconds >= graceSeconds) {
          suspendForNoListeners(snapshot);
        }
      }
      broadcastStatus();
    } catch (err) {
      console.warn('[engine] listener monitor failed:', err.message);
    }
    await sleep(5_000);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (req.method === 'GET') {
    if (url.pathname === '/health') {
      return send(res, 200, { ok: true, playing, paused });
    }
    if (url.pathname === '/api/status') {
      return send(res, 200, buildStatus());
    }
    if (url.pathname === '/api/queue') {
      return send(res, 200, { queue: queue.slice(0, 10) });
    }
    if (url.pathname === '/api/podcast-queue') {
      return send(res, 200, { queue: Array.isArray(engineSettings.podcastQueue) ? engineSettings.podcastQueue : [] });
    }
    if (url.pathname === '/api/podcast-refresh') {
      try {
        const refreshed = await refreshPodcastQueueFromFeeds();
        broadcastStatus();
        return send(res, 200, { ok: true, ...refreshed });
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message });
      }
    }
    if (url.pathname === '/api/podcast-state') {
      return send(res, 200, buildPodcastStatus());
    }
    if (url.pathname === '/api/podcast-transcripts') {
      const limit = Math.max(1, Number(engineSettings.podcastTranscriptPrefetchLimit || 5));
      const transcripts = (Array.isArray(engineSettings.podcastQueue) ? engineSettings.podcastQueue : [])
        .slice(0, limit)
        .map(episode => {
          const cached = readCachedPodcastTranscript(episode);
          return {
            id: episode.id || episode.audioUrl,
            title: episode.title,
            feedTitle: episode.feedTitle,
            provider: cached?.provider || null,
            status: cached?.status || null,
            hasTranscript: cached?.status === 'completed',
            savedAt: cached?.savedAt || null,
          };
        });
      return send(res, 200, { transcripts });
    }
    if (url.pathname === '/api/liked') {
      return send(res, 200, { liked: await loadLiked() });
    }
    if (url.pathname === '/api/blocked') {
      return send(res, 200, { blocked: loadBlockedRows() });
    }
    if (url.pathname === '/api/memory') {
      const memory = memorySafe('load memory api', () => loadMemory()) || {};
      return send(res, 200, {
        updatedAt: memory.updatedAt || null,
        today: memory.dailyMemory?.[new Date().toISOString().slice(0, 10)] || null,
        recentTracks: (memory.recentTracks || []).slice(0, 20),
        recentPodcastSegments: (memory.podcastSegments || []).slice(0, 10),
        openCallIns: (memory.callIns || []).filter(c => c.status === 'open').slice(0, 20),
      });
    }
    if (url.pathname === '/api/call-ins') {
      const status = url.searchParams.get('status') || '';
      const limit = Number(url.searchParams.get('limit') || 50);
      return send(res, 200, { callIns: memorySafe('list call-ins', () => listCallIns({ status, limit })) || [] });
    }
    if (url.pathname === '/api/liked/export') {
      const rows = likedToExportRows(await loadLiked());
      const format = url.searchParams.get('format') || 'json';
      if (format === 'txt') {
        return send(res, 200, rows.map(r => `${r.title} — ${r.artist}\n${r.url}\n${r.id}`).join('\n\n'), 'text/plain; charset=utf-8');
      }
      if (format === 'csv') {
        const esc = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
        const csv = [
          ['id', 'title', 'artist', 'url', 'likedAt'].map(esc).join(','),
          ...rows.map(r => [r.id, r.title, r.artist, r.url, r.likedAt].map(esc).join(',')),
        ].join('\n');
        return send(res, 200, csv, 'text/csv; charset=utf-8');
      }
      return send(res, 200, { tracks: rows });
    }
    if (url.pathname === '/api/wavlake-playlist') {
      try {
        const playlist = await fetchWavlakePlaylist(url.searchParams.get('id') || engineSettings.wavlakePlaylistId);
        return send(res, 200, {
          id: playlist.id,
          title: playlist.title,
          count: playlist.tracks.length,
          tracks: playlist.tracks,
        });
      } catch(e) {
        return send(res, 400, { error: e.message });
      }
    }
    if (url.pathname === '/api/settings') {
      return send(res, 200, engineSettings);
    }
    if (url.pathname === '/api/volume') {
      return send(res, 200, await getOutputVolumes());
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type':                'text/event-stream',
        'Cache-Control':               'no-cache',
        'Connection':                  'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('retry: 3000\n\n');
      res.write(`event: status\ndata: ${JSON.stringify(buildStatus())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
  }

  if (req.method === 'POST') {
    if (url.pathname === '/api/skip') {
      const skipped = currentItem;
      if (skipped?.kind === 'music') {
        memorySafe('record track skipped', () => recordTrackSkipped(skipped, { reason: 'skip' }));
      }
      pausedResumeItem = null;
      killAll();
      playing = false;
      currentPlaybackStartSeconds = 0;
      broadcastStatus();
      return send(res, 200, { ok: true, action: 'skip' });
    }

    if (url.pathname === '/api/pause') {
      if (!paused) {
        pausedResumeItem = snapshotCurrentForPause();
        persistPodcastPausePosition(pausedResumeItem);
        paused  = true;
        playing = false;
        killAll();
        broadcastStatus();
      }
      return send(res, 200, { ok: true, action: 'pause', resume: pausedResumeItem });
    }

    if (url.pathname === '/api/play') {
      armManualStartGrace('api-play');
      if (paused) { paused = false; broadcastStatus(); }
      return send(res, 200, { ok: true, action: 'play', resume: pausedResumeItem });
    }

    if (url.pathname === '/api/restart') {
      armManualStartGrace('api-restart');
      const starter = await startFreshRadioSession('remote-restart');
      return send(res, 200, { ok: true, action: 'restart', starter });
    }

    if (url.pathname === '/api/toggle') {
      if (paused) {
        armManualStartGrace('api-toggle-play');
        paused = false;
        broadcastStatus();
        return send(res, 200, { ok: true, action: 'play', resume: pausedResumeItem });
      } else {
        pausedResumeItem = snapshotCurrentForPause();
        persistPodcastPausePosition(pausedResumeItem);
        paused  = true;
        playing = false;
        killAll();
        broadcastStatus();
        return send(res, 200, { ok: true, action: 'pause', resume: pausedResumeItem });
      }
    }

    if (url.pathname === '/api/ban-current') {
      if (!currentItem) return send(res, 400, { error: 'No current item' });
      if (currentItem.kind !== 'music') return send(res, 400, { error: 'Can only ban music tracks' });
      const item = currentItem;
      pausedResumeItem = null;
      blockTrack(item);
      memorySafe('record track banned', () => recordTrackBanned(item));
      const key = `${item.artist} — ${item.title}`;
      queue = queue.filter(t => `${t.artist} — ${t.title}` !== key);
      killAll();
      broadcastStatus();
      return send(res, 200, { ok: true, action: 'ban', track: item });
    }

    if (url.pathname === '/api/like-current') {
      if (!currentItem) return send(res, 400, { error: 'No current item' });
      if (currentItem.kind !== 'music') return send(res, 400, { error: 'Can only like music tracks' });
      const liked = await saveLiked(currentItem);
      memorySafe('record track liked', () => recordTrackLiked(currentItem));
      broadcastStatus();
      return send(res, 200, { ok: true, action: 'like', track: currentItem, totalLiked: liked.length });
    }

    if (url.pathname === '/api/unlike-track') {
      const body = await readJsonBody(req);
      const id = String(body.id || body.trackId || '').trim();
      if (!id) return send(res, 400, { error: 'Missing track id' });
      const liked = await removeLikedTrack(id);
      if (engineSettings.musicSource === 'prLikedSongs') queue = queue.filter(t => String(t.id || '') !== id);
      broadcastStatus();
      return send(res, 200, { ok: true, action: 'unlike-track', id, liked });
    }

    if (url.pathname === '/api/unblock-track') {
      const body = await readJsonBody(req);
      const value = String(body.value || body.id || '').trim();
      if (!value) return send(res, 400, { error: 'Missing blocklist value' });
      const blocked = unblockTrack(value);
      broadcastStatus();
      return send(res, 200, { ok: true, action: 'unblock-track', value, blocked });
    }

    if (url.pathname === '/api/call-in') {
      const body = await readJsonBody(req);
      try {
        const callIn = memorySafe('add call-in', () => addCallIn({
          text: body.text,
          mood: body.mood,
          intent: body.intent,
          source: body.source || 'remote',
        }));
        if (!callIn) throw new Error('Call-in could not be saved');
        broadcastStatus();
        return send(res, 200, { ok: true, callIn });
      } catch (err) {
        return send(res, 400, { ok: false, error: err.message });
      }
    }

    if (url.pathname === '/api/call-ins/archive') {
      const body = await readJsonBody(req);
      const row = memorySafe('archive call-in', () => archiveCallIn(String(body.id || ''), body.status || 'archived'));
      if (!row) return send(res, 404, { ok: false, error: 'Call-in not found' });
      broadcastStatus();
      return send(res, 200, { ok: true, callIn: row });
    }

    if (url.pathname === '/api/boost-current') {
      if (!currentItem) return send(res, 400, { error: 'No current item' });
      const body = await readJsonBody(req);
      const amountSats = Math.max(1, Number(body.amountSats || engineSettings.boostAmountSats || 100));
      return send(res, 200, {
        ok: true,
        action: 'boost-current',
        amountSats,
        track: currentItem,
        handledBy: 'frontend-v4v',
      });
    }

    if (url.pathname === '/api/sat-streaming') {
      const body = await readJsonBody(req);
      engineSettings = {
        ...engineSettings,
        satStreamingEnabled: !!body.enabled,
      };
      saveSettings(engineSettings);
      broadcastStatus();
      return send(res, 200, engineSettings);
    }

    if (url.pathname === '/api/settings') {
      const body = await readJsonBody(req);
      const allowed = {};
      for (const key of [
        'satStreamingEnabled',
        'boostAmountSats',
        'satRatePerMinute',
        'supportPREnabled',
        'prSplitPercent',
        'moderationEnabled',
        'moderationAfterSongs',
        'crossfadeEnabled',
        'crossfadeSeconds',
        'moderationDuckingEnabled',
        'moderationDuckSeconds',
        'audioAnalysisEnabled',
        'audioAnalysisWindowSeconds',
        'transitionIntroAnalysisEnabled',
        'transitionIntroSkipMaxSeconds',
        'recentTrackCooldownMinutes',
        'musicSource',
        'wavlakePlaylistId',
        'wavlakePlaylistTitle',
        'wavlakePlaylists',
        'podcastAfterSongs',
        'podcastFeedUrl',
        'podcastFeeds',
        'podcastQueue',
        'podcastQueueRefreshedAt',
        'podcastsEnabled',
        'podcastSegmentMinMinutes',
        'podcastSegmentMaxMinutes',
        'podcastSttFallbackEnabled',
        'podcastPreferTranscriptChapters',
        'podcastTranscriptPrefetchEnabled',
        'podcastTranscriptPrefetchLimit',
        'podcastTranscriptProvider',
        'podcastAdSkipEnabled',
        'musicBreakTracksAfterPodcast',
        'ttsProvider',
        'elevenLabsVoiceIdEn',
        'elevenLabsVoiceIdDe',
        'elevenLabsModelId',
        'elevenLabsVoiceSettings',
        'fishVoiceIdEn',
        'fishVoiceIdDe',
        'autoSuspendWhenNoListeners',
        'noListenerGraceSeconds',
        'streamListenerMaxAgeMinutes',
        'newSessionAfterMinutes',
        'resumeWithLikedSong',
        'sessionIntroAfterFirstSong',
      ]) {
        if (Object.prototype.hasOwnProperty.call(body, key)) allowed[key] = body[key];
      }
      engineSettings = { ...engineSettings, ...allowed };
      if (Object.prototype.hasOwnProperty.call(allowed, 'musicSource')
          || Object.prototype.hasOwnProperty.call(allowed, 'wavlakePlaylistId')
          || Object.prototype.hasOwnProperty.call(allowed, 'wavlakePlaylists')) {
        if (Array.isArray(allowed.wavlakePlaylists) && allowed.wavlakePlaylists.length > 0) {
          allowed.wavlakePlaylistId = allowed.wavlakePlaylists[0]?.id || allowed.wavlakePlaylistId || '';
          allowed.wavlakePlaylistTitle = allowed.wavlakePlaylists[0]?.title || allowed.wavlakePlaylistTitle || '';
        }
        queue = [];
      }
      saveSettings(engineSettings);
      broadcastStatus();
      return send(res, 200, engineSettings);
    }

    if (url.pathname === '/api/podcast-queue') {
      const body = await readJsonBody(req);
      const nextQueue = Array.isArray(body.queue) ? body.queue : [];
      engineSettings = { ...engineSettings, podcastQueue: nextQueue };
      saveSettings(engineSettings);
      prefetchPodcastTranscripts(nextQueue, 'queue-save');
      broadcastStatus();
      return send(res, 200, { ok: true, queue: engineSettings.podcastQueue });
    }

    if (url.pathname === '/api/podcast-transcripts/prefetch') {
      const limit = Math.max(1, Number(engineSettings.podcastTranscriptPrefetchLimit || 5));
      const episodes = (Array.isArray(engineSettings.podcastQueue) ? engineSettings.podcastQueue : []).slice(0, limit);
      prefetchPodcastTranscripts(episodes, 'api-prefetch');
      broadcastStatus();
      return send(res, 200, { ok: true, queued: episodes.length });
    }

    if (url.pathname === '/api/podcast-refresh') {
      try {
        const refreshed = await refreshPodcastQueueFromFeeds();
        broadcastStatus();
        return send(res, 200, { ok: true, ...refreshed });
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message });
      }
    }

    if (url.pathname === '/api/play-podcast') {
      const body = await readJsonBody(req);
      const episode = body.episode || body;
      if (!episode?.audioUrl && !episode?.liveUrl) return send(res, 400, { error: 'Missing podcast episode audioUrl' });
      forcedNextItem = podcastEpisodeToItem(episode);
      pausedResumeItem = null;
      paused = false;
      engineSettings = {
        ...engineSettings,
        podcastQueue: (Array.isArray(engineSettings.podcastQueue) ? engineSettings.podcastQueue : [])
          .filter(ep => ep.id !== episode.id),
      };
      saveSettings(engineSettings);
      killAll();
      playing = false;
      currentPlaybackStartSeconds = 0;
      broadcastStatus();
      return send(res, 200, { ok: true, action: 'play-podcast', episode });
    }

    if (url.pathname === '/api/skip-podcast-segment') {
      if (currentItem?.kind !== 'podcast') return send(res, 400, { error: 'No podcast segment is playing' });
      pausedResumeItem = null;
      podcastSegmentSkipRequested = true;
      killAll();
      broadcastStatus();
      return send(res, 200, { ok: true, action: 'skip-podcast-segment' });
    }

    if (url.pathname === '/api/abandon-podcast') {
      const body = await readJsonBody(req);
      const key = body.episodeKey || podcastState.currentEpisodeKey;
      if (!key || !podcastState.episodes?.[key]) return send(res, 404, { error: 'No podcast episode state found' });
      podcastState.episodes[key] = {
        ...podcastState.episodes[key],
        positionSeconds: 0,
        completed: true,
      };
      pausedResumeItem = null;
      if (currentItem?.kind === 'podcast') killAll();
      podcastState.active = null;
      currentPodcastPlayback = null;
      savePodcastState();
      broadcastStatus();
      return send(res, 200, { ok: true, action: 'abandon-podcast', episodeKey: key, podcastState: buildPodcastStatus() });
    }

    if (url.pathname === '/api/volume') {
      const body = await readJsonBody(req);
      try {
        if (body.output && Object.prototype.hasOwnProperty.call(body, 'volume')) {
          await setOutputVolume(String(body.output), body.volume);
        } else {
          for (const output of OUTPUTS) {
            if (Object.prototype.hasOwnProperty.call(body, output.name)) {
              await setOutputVolume(output.name, body[output.name]);
            }
          }
        }
      } catch (err) {
        return send(res, 400, {
          error: err.message,
          availableOutputs: OUTPUTS.map(output => output.name),
        });
      }
      return send(res, 200, await getOutputVolumes());
    }
  }

  send(res, 404, { error: `Not found: ${url.pathname}` });
});

// ── Startup ───────────────────────────────────────────────────────────────────

mkdirSync(TMP_DIR, { recursive: true });

server.listen(PORT, HOST, () => {
  console.log(`[radio-engine] listening on http://${HOST}:${PORT}`);
  console.log(`[radio-engine] outputs: ${OUTPUTS.map(o => `${o.name}(${o.sink})`).join(', ')}`);
  console.log(`[radio-engine] moderation every ${MODERATION_AFTER_SONGS} songs, podcast every ${PODCAST_AFTER_SONGS} songs`);
  listenerMonitorLoop().catch(err => console.error('[radio-engine] listener monitor crashed:', err));
  radioLoop().catch(err => {
    console.error('[radio-engine] loop crashed:', err);
    process.exit(1);
  });
});

function shutdown() {
  shuttingDown = true;
  paused = true;
  playing = false;
  killAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
