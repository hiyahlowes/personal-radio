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
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir, homedir } from 'node:os';
import process from 'node:process';

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
const TMP_DIR        = path.join(tmpdir(), 'personal-radio');
const PUBLIC_DIR     = path.join(process.cwd(), 'public');

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw);
}

const APP_PORT   = Number(process.env.APP_PORT || 8899);
const CHARTS_URL = `http://127.0.0.1:${APP_PORT}/.netlify/functions/wavlake-charts`;
const WAVLAKE_PLAYLIST_URL = 'https://catalog.wavlake.com/v1/playlists';
const TTS_ELEVEN_URL = `http://127.0.0.1:${APP_PORT}/.netlify/functions/podcast-proxy?action=tts`;
const TTS_FISH_URL   = `http://127.0.0.1:${APP_PORT}/.netlify/functions/podcast-proxy?action=tts-fish`;
const PODCAST_TEXT_URL = `http://127.0.0.1:${APP_PORT}/.netlify/functions/podcast-proxy?action=text`;
const PODCAST_STT_URL  = `http://127.0.0.1:${APP_PORT}/.netlify/functions/podcast-proxy?action=stt`;
// Moderation text via claude-proxy (direct Anthropic API, fast ~2-3s).
// Falls back to via-moderator only if PERSONAL_RADIO_USE_VIA=true is set.
const CLAUDE_URL = `http://127.0.0.1:${APP_PORT}/.netlify/functions/claude-proxy`;

const TTS_LANG     = process.env.TTS_LANG    || 'de';
const PODCAST_URL  = process.env.PODCAST_FEED_URL || 'https://feeds.fountain.fm/UZSKQcrOnhqYS1JopxGg';

const MODERATION_AFTER_SONGS = Number(process.env.MODERATION_AFTER_SONGS || 3);
const PODCAST_AFTER_SONGS    = Number(process.env.PODCAST_AFTER_SONGS    || 6);
const CACHE_HTTP_AUDIO        = envFlag('PERSONAL_RADIO_CACHE_HTTP_AUDIO', false);
const PULSE_LATENCY_MSEC      = process.env.PULSE_LATENCY_MSEC || '350';
const FFPLAY_ANALYZE_DURATION = process.env.PERSONAL_RADIO_FFPLAY_ANALYZE_DURATION || '1000000';
const FFPLAY_PROBE_SIZE       = process.env.PERSONAL_RADIO_FFPLAY_PROBE_SIZE || '1000000';
const FFPLAY_AUDIO_FILTER     = process.env.PERSONAL_RADIO_FFPLAY_AUDIO_FILTER || 'aresample=async=1000:first_pts=0';
const TTS_TAIL_PAD_SECONDS    = Number(process.env.PERSONAL_RADIO_TTS_TAIL_PAD_SECONDS || 0.6);
const PODCAST_INTRO_JINGLE    = process.env.PERSONAL_RADIO_PODCAST_INTRO_JINGLE || path.join(PUBLIC_DIR, 'podcast-intro.mp3');
const PODCAST_RETURN_JINGLE   = process.env.PERSONAL_RADIO_PODCAST_RETURN_JINGLE || path.join(PUBLIC_DIR, 'studio-return.mp3');

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
  musicSource: 'topCharts',
  wavlakePlaylistId: '',
  wavlakePlaylistTitle: '',
  podcastAfterSongs: PODCAST_AFTER_SONGS,
  podcastFeedUrl: PODCAST_URL,
  podcastFeeds: [],
  podcastQueue: [],
  podcastsEnabled: true,
  podcastSegmentMinMinutes: 8,
  podcastSegmentMaxMinutes: 15,
  podcastSttFallbackEnabled: true,
  podcastPreferTranscriptChapters: true,
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
let forcedNextItem = null;
let podcastState = loadPodcastState();
podcastBreakSongsRemaining = Number(podcastState.breakSongsRemaining || 0);
let currentPodcastPlayback = null;
let podcastSegmentSkipRequested = false;
let podcastSessionActive = false;
let shuttingDown = false;
let pausedResumeItem = null;
let currentPlaybackStartSeconds = 0;

// Pre-generated moderation ready to play: Promise<ModerationItem|null>|null
let pendingModerationPromise = null;

// Per-output state
const outputState = {};
for (const o of OUTPUTS) {
  outputState[o.name] = { playing: false, error: null, pid: null, sink: o.sink };
}

// Active ffplay processes for the current item: Map<outputName, ChildProcess>
let activeProcs = new Map();
// Cancellation token for the current playback
let skipToken = { cancelled: false };

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

function playbackPositionSeconds() {
  if (!startedAt) return Math.max(0, Math.floor(currentPlaybackStartSeconds || 0));
  const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
  return Math.max(0, Math.floor((currentPlaybackStartSeconds || 0) + elapsed));
}

function snapshotCurrentForPause() {
  if (!currentItem) return null;
  const positionSeconds = playbackPositionSeconds();
  const item = { ...currentItem };
  delete item.tmpFile;
  return {
    item,
    positionSeconds,
    savedAt: new Date().toISOString(),
  };
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
    settings: engineSettings,
    source: engineSettings.musicSource === 'wavlakePlaylist'
      ? 'wavlake-playlist'
      : engineSettings.musicSource === 'prLikedSongs'
        ? 'pr-liked-songs'
        : 'wavlake-top40',
    songCount,
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
    hasTranscript: !!(active?.hasTranscript ?? episodeState?.transcriptUrl),
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

async function refillQueue() {
  let tracks;
  try {
    if (engineSettings.musicSource === 'wavlakePlaylist' && engineSettings.wavlakePlaylistId) {
      const playlist = await fetchWavlakePlaylist(engineSettings.wavlakePlaylistId);
      engineSettings = { ...engineSettings, wavlakePlaylistTitle: playlist.title };
      saveSettings(engineSettings);
      tracks = playlist.tracks;
      console.log(`[engine] queue refilled from Wavlake playlist "${playlist.title}": ${tracks.length} tracks`);
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
  queue = shuffle(tracks).filter(t => !isBlocked(t));
  console.log(`[engine] queue ready: ${queue.length} music tracks`);
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

function roundRobinPodcastQueue(perFeed) {
  if (perFeed.length === 0) return [];
  if (perFeed.length === 1) return perFeed[0];
  const capped = perFeed.map(episodes => episodes.slice(0, 2));
  const cursors = new Array(capped.length).fill(0);
  const result = [];
  let remaining = capped.reduce((sum, episodes) => sum + episodes.length, 0);
  while (remaining > 0) {
    for (let i = 0; i < capped.length; i++) {
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
  const queue = roundRobinPodcastQueue(perFeed).filter(ep => ep.audioUrl);
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
    if (episode?.audioUrl || episode?.liveUrl) return podcastEpisodeToItem(episode);
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
  return raw.slice(-1600).replace(/\s+/g, ' ').trim();
}

const transcriptCache = new Map();

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
  const entries = parseCueEntries(raw);
  if (!entries.length) return null;
  const minTarget = startSeconds + minSeconds;
  const maxTarget = startSeconds + maxSeconds;
  const terminal = /[.!?…]["')\]]*$/;
  for (let i = 0; i < entries.length; i++) {
    const cue = entries[i];
    if (cue.end < minTarget || cue.end > maxTarget) continue;
    const next = entries[i + 1];
    const gap = next ? next.start - cue.end : 2;
    if (terminal.test(cue.text.trim()) && gap >= 1.5) {
      return { seconds: cue.end, title: '', source: 'transcriptCue' };
    }
  }
  const firstAfterMin = entries.find(e => e.end >= minTarget && e.end <= maxTarget);
  return firstAfterMin ? { seconds: firstAfterMin.end, title: '', source: 'transcriptCue' } : null;
}

function parseSilenceCut(stderr, startSeconds, minSeconds, maxSeconds) {
  const minTarget = startSeconds + minSeconds;
  const maxTarget = startSeconds + maxSeconds;
  const starts = [...String(stderr || '').matchAll(/silence_start:\s*([0-9.]+)/g)]
    .map(m => Number(m[1]))
    .filter(Number.isFinite);

  for (const raw of starts) {
    const absolute = raw >= minTarget - 0.5 ? raw : minTarget + raw;
    const clamped = Math.max(minTarget, absolute);
    if (clamped >= minTarget && clamped <= maxTarget) {
      return { seconds: clamped, title: '', source: 'silence' };
    }
  }

  return null;
}

async function findSilenceCut(item, startSeconds, minSeconds, maxSeconds) {
  const windowStart = startSeconds + minSeconds;
  const windowDuration = Math.max(1, maxSeconds - minSeconds);
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
    const cut = parseSilenceCut(result.stderr, startSeconds, minSeconds, maxSeconds);
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
  let cut = null;
  let transcriptRaw = '';

  if (engineSettings.podcastPreferTranscriptChapters !== false) {
    cut = findChapterCut(episodeState.chapters, startSeconds, minSeconds, maxSeconds);
    if (!cut && episodeState.transcriptUrl) {
      try {
        transcriptRaw = await fetchTranscriptRaw(episodeState.transcriptUrl);
        cut = findTranscriptCut(transcriptRaw, startSeconds, minSeconds, maxSeconds);
      } catch(e) {
        console.warn('[engine] podcast transcript cut failed:', e.message);
      }
    }
  }

  if (!cut) {
    cut = await findSilenceCut(item, startSeconds, minSeconds, maxSeconds);
  }

  const endSeconds = Math.min(Math.max(cut?.seconds || hardMaxEnd, startSeconds + minSeconds), hardMaxEnd);
  return {
    startSeconds,
    endSeconds,
    durationSeconds: Math.max(1, endSeconds - startSeconds),
    minSeconds,
    maxSeconds,
    cutSource: cut?.source || 'hardMax',
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

  if (episodeState.transcriptUrl) {
    try {
      if (!transcriptRaw) transcriptRaw = await fetchTranscriptRaw(episodeState.transcriptUrl);
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

async function generatePodcastModerationText(item, episodeState, segment, context) {
  try {
    const system = [
      'Du bist ein deutschsprachiger Radiosprecher für ein persönliches Radio.',
      'Erzeuge eine kurze, persönliche Radio-Moderation auf Deutsch.',
      'Fasse zusammen, was im gerade gehörten Podcast-Abschnitt wirklich vorkam.',
      'Kein generisches "spannendes Gespräch". Nutze den Transcript-/STT-/Kapitel-Kontext.',
      'Dann leite organisch in Musik über.',
      'Ton: warm, klar, intelligent, nicht werblich.',
      'Wenn kein brauchbarer Kontext vorhanden ist, sag das ehrlich und knapp. Nicht halluzinieren.',
      'Antworte NUR mit sendefähigem Text.',
    ].join(' ');
    const task = [
      `Show: ${episodeState.showTitle}`,
      `Episode: ${episodeState.episodeTitle}`,
      `Part: ${episodeState.part}`,
      `Segment: ${Math.round(segment.startSeconds)}s bis ${Math.round(segment.endSeconds)}s`,
      context.chapterTitle ? `Kapitel: ${context.chapterTitle}` : '',
      `Kontextquelle: ${context.source}`,
      '',
      `Kontext:\n${String(context.excerpt || '').slice(0, 2200)}`,
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
    const text = json?.content?.[0]?.text || '';
    return text.trim() || null;
  } catch(e) {
    console.warn('[engine] podcast moderation text failed:', e.message);
    return null;
  }
}

async function buildPodcastModerationItem(item, episodeState, segment, context) {
  console.log(`[engine] generating podcast moderation (${context.source})…`);
  const text = await generatePodcastModerationText(item, episodeState, segment, context);
  const fallback = `Das war ein Abschnitt aus ${episodeState.showTitle}: ${episodeState.episodeTitle}. Für die genaue Einordnung fehlt mir gerade belastbarer Kontext, deshalb halten wir es ehrlich kurz und lassen das Gehörte mit Musik nachklingen.`;
  const tts = await ttsToTempFile(text || fallback);
  if (!tts?.file) return null;
  return {
    kind: 'moderation',
    id: `podcast-mod-${Date.now()}`,
    title: 'Podcast Moderation',
    artist: 'Radio Host',
    artworkUrl: '',
    liveUrl: tts.file,
    duration: tts.durationSeconds || 0,
    tmpFile: tts.file,
    scriptText: text || fallback,
  };
}

async function generatePodcastIntroText(item, episodeState, isResume) {
  try {
    const system = [
      'Du bist ein deutschsprachiger Radiosprecher für ein persönliches Radio.',
      'Erzeuge eine sehr kurze, warme Podcast-Anmoderation auf Deutsch.',
      'Erwähne primär den Sendungsnamen, nicht unnötig Datum, Uhrzeit oder Episodennummern.',
      'Erwähne keine nächste Musik. Fokus nur auf den Podcast.',
      'Antworte NUR mit sendefähigem Text.',
    ].join(' ');
    const minutes = Math.floor(Number(episodeState.positionSeconds || 0) / 60);
    const task = isResume
      ? [
          `Sendung: ${episodeState.showTitle}`,
          `Episode: ${episodeState.episodeTitle}`,
          `Resume-Position: ca. Minute ${minutes}`,
          episodeState.lastContextSource ? `Letzte Kontextquelle: ${episodeState.lastContextSource}` : '',
          '',
          'Nimm den Podcast kurz wieder auf. Maximal 25 Wörter. Klinge wie ein Moderator, der weiß, dass wir schon mittendrin waren.',
        ].filter(Boolean).join('\n')
      : [
          `Sendung: ${episodeState.showTitle}`,
          `Episode: ${episodeState.episodeTitle}`,
          episodeState.description ? `Beschreibung: ${String(episodeState.description).slice(0, 600)}` : '',
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
    const text = json?.content?.[0]?.text || '';
    return text.trim() || null;
  } catch(e) {
    console.warn('[engine] podcast intro text failed:', e.message);
    return null;
  }
}

async function buildPodcastIntroItem(item, episodeState, isResume) {
  const text = await generatePodcastIntroText(item, episodeState, isResume);
  const fallback = isResume
    ? `Und wir gehen zurück in ${episodeState.showTitle}, ungefähr ab Minute ${Math.max(1, Math.floor(Number(episodeState.positionSeconds || 0) / 60))}.`
    : `Zeit für ${episodeState.showTitle}. Wir hören kurz rein.`;
  const tts = await ttsToTempFile(text || fallback);
  if (!tts?.file) return null;
  return {
    kind: 'moderation',
    id: `podcast-intro-${Date.now()}`,
    title: 'Podcast Intro',
    artist: 'Radio Host',
    artworkUrl: item.artworkUrl || '',
    liveUrl: tts.file,
    duration: tts.durationSeconds || 0,
    tmpFile: tts.file,
    scriptText: text || fallback,
  };
}

async function buildPodcastReturnItem(episodeState) {
  const part = Math.max(2, Number(episodeState.part || 2));
  const text = `Und wir sind zurück bei ${episodeState.showTitle}. Weiter geht es mit Teil ${part} von ${episodeState.episodeTitle}.`;
  const tts = await ttsToTempFile(text);
  if (!tts?.file) return null;
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

async function playPodcastSegment(item) {
  podcastSessionActive = true;
  const { episodeKey, state } = getEpisodeState(item);
  if (state.completed) {
    state.positionSeconds = 0;
    state.completed = false;
    state.part = 1;
  }
  const segment = await choosePodcastSegment(item, state);
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
    hasTranscript: !!state.transcriptUrl,
    hasChapters: Array.isArray(state.chapters) && state.chapters.length > 0,
  };
  podcastState.active = currentPodcastPlayback;
  podcastState.currentEpisodeKey = episodeKey;
  savePodcastState();

  console.log(`[engine] podcast segment part ${state.part}: ${Math.round(segment.startSeconds)}s → ${Math.round(segment.endSeconds)}s breakReason=${segment.cutSource}`);
  broadcastStatus();

  const startedMs = Date.now();
  await playItemOnAllOutputs(item, {
    startSeconds: segment.startSeconds,
    durationSeconds: segment.durationSeconds,
    hardStopMs: Math.ceil((segment.durationSeconds + 5) * 1000),
  });

  const actualElapsed = Math.max(0, Math.min(segment.durationSeconds, (Date.now() - startedMs) / 1000));
  const endPosition = itemWasKilled
    ? Math.min(segment.endSeconds, segment.startSeconds + actualElapsed)
    : segment.endSeconds;
  const reachedEpisodeEnd = state.durationSeconds > 0 && endPosition >= state.durationSeconds - 5;

  state.positionSeconds = reachedEpisodeEnd ? 0 : endPosition;
  state.durationSeconds = state.durationSeconds || item.duration || 0;
  state.part = reachedEpisodeEnd ? 1 : state.part + 1;
  state.completed = reachedEpisodeEnd;
  state.lastSegmentStart = segment.startSeconds;
  state.lastSegmentEnd = endPosition;

  let context = { source: 'fallback', excerpt: '', chapterTitle: '' };
  const shouldModerate = (!itemWasKilled || podcastSegmentSkipRequested) && actualElapsed >= 1;
  if (shouldModerate) {
    context = await buildPodcastSegmentContext(item, state, { ...segment, endSeconds: endPosition });
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
    breakReason: segment.cutSource,
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

async function generateModerationText(currentSong) {
  try {
    const system = 'Du bist ein deutschsprachiger Radiosprecher für einen persönlichen Musiksender. Dein Stil ist warm, locker und authentisch. Antworte NUR mit dem direkt sendefähigen Text — keine Erklärungen, keine Anführungszeichen.';
    const task   = `Schreibe eine kurze Moderation (1-2 Sätze) für den gerade gespielten Song: "${currentSong.artist} — ${currentSong.title}". Natürlich und spontan, wie ein echter Radiosprecher.`;
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
    const text = json?.content?.[0]?.text || '';
    if (!text) throw new Error('empty moderation response');
    return text.trim();
  } catch(e) {
    console.warn('[engine] moderation text failed:', e.message);
    return null;
  }
}

async function ttsToTempFile(text) {
  mkdirSync(TMP_DIR, { recursive: true });
  const tmpFile = path.join(TMP_DIR, `mod-${Date.now()}.mp3`);
  try {
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

async function buildModerationItem(afterSong) {
  console.log('[engine] generating moderation…');
  const text    = await generateModerationText(afterSong);
  if (!text) return null;
  const tts = await ttsToTempFile(text);
  if (!tts?.file) return null;
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
  };
}

// ── Multi-output playback ─────────────────────────────────────────────────────

/**
 * Play a URL/file on a single output sink.
 * Resolves when ffplay exits (naturally or killed).
 * Never rejects.
 */
async function cacheHttpAudioForStablePlayback(url, options = {}) {
  if (!CACHE_HTTP_AUDIO || options.cacheHttpAudio !== true) return { playUrl: url, tmpFile: null };
  // Do not download full podcast episodes; segmented podcast playback uses -ss/-t.
  if (!/^https?:\/\//i.test(url)) return { playUrl: url, tmpFile: null };
  if (Number.isFinite(options.startSeconds) || Number.isFinite(options.durationSeconds)) return { playUrl: url, tmpFile: null };

  try {
    mkdirSync(TMP_DIR, { recursive: true });
    const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error('download too small');
    const tmpFile = path.join(TMP_DIR, `play-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
    writeFileSync(tmpFile, buf);
    console.log(`[engine] cached audio for stable playback: ${tmpFile} (${buf.length} bytes)`);
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
    let hardStop = null;
    if (Number.isFinite(options.hardStopMs) && options.hardStopMs > 1000) {
      hardStop = setTimeout(() => {
        if (!proc.killed) {
          console.warn(`[engine] hard-stopping ffplay on ${output.name} after ${Math.round(options.hardStopMs / 1000)}s`);
          try { proc.kill('SIGTERM'); } catch {}
        }
      }, options.hardStopMs);
    }

    outputState[output.name].playing = true;
    outputState[output.name].pid     = proc.pid;
    outputState[output.name].error   = null;
    activeProcs.set(output.name, proc);

    proc.on('close', code => {
      if (hardStop) clearTimeout(hardStop);
      if (playbackTmpFile) { try { unlinkSync(playbackTmpFile); } catch {} }
      outputState[output.name].playing = false;
      outputState[output.name].pid     = null;
      activeProcs.delete(output.name);
      resolve({ output: output.name, code, reason: 'close' });
    });

    proc.on('error', err => {
      if (hardStop) clearTimeout(hardStop);
      if (playbackTmpFile) { try { unlinkSync(playbackTmpFile); } catch {} }
      outputState[output.name].playing = false;
      outputState[output.name].pid     = null;
      outputState[output.name].error   = err.message;
      activeProcs.delete(output.name);
      console.error(`[engine] ffplay spawn error on ${output.name}: ${err.message}`);
      resolve({ output: output.name, code: -1, reason: 'error' });
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

  await Promise.allSettled(promises);

  // Clear any stragglers
  for (const [name, proc] of activeProcs) {
    if (!proc.killed) try { proc.kill('SIGTERM'); } catch {}
    outputState[name].playing = false;
    outputState[name].pid     = null;
  }
  activeProcs.clear();
}

function killAll() {
  skipToken.cancelled = true;
  itemWasKilled       = true;
  for (const [name, proc] of activeProcs) {
    if (!proc.killed) try { proc.kill('SIGTERM'); } catch {}
    outputState[name].playing = false;
    outputState[name].pid     = null;
  }
  activeProcs.clear();
}

// ── Radio loop ────────────────────────────────────────────────────────────────

async function radioLoop() {
  console.log('[engine] radio loop starting');
  while (!shuttingDown) {
    if (paused) { await sleep(500); continue; }

    if (queue.length === 0) {
      const ok = await refillQueue();
      if (!ok) { await sleep(10_000); continue; }
    }

    let nextItem = null;
    let resumeStartSeconds = 0;
    let resumedFromPause = false;
    let resumedAfterPodcastBreak = false;

    if (pausedResumeItem) {
      nextItem = pausedResumeItem.item;
      resumeStartSeconds = Math.max(0, Number(pausedResumeItem.positionSeconds || 0));
      resumedFromPause = true;
      pausedResumeItem = null;
      console.log(`[engine] resuming paused ${nextItem.kind}: ${nextItem.artist} — ${nextItem.title} at ${Math.round(resumeStartSeconds)}s`);
    }

    if (!nextItem && forcedNextItem) {
      nextItem = forcedNextItem;
      forcedNextItem = null;
    }

    // ── Check pre-generated moderation ──────────────────────────────────────
    if (!nextItem && pendingModerationPromise !== null && !itemWasKilled) {
      // Wait up to 6s for pre-generated moderation (generation runs during prev song)
      const modItem = await Promise.race([
        pendingModerationPromise,
        sleep(6_000).then(() => null),
      ]);
      pendingModerationPromise = null;
      if (modItem) {
        nextItem = modItem;
        songCount = 0;
      }
    }
    pendingModerationPromise = null; // clear regardless (skipped or just-used)

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
    broadcastStatus();

    // Pre-generate moderation in background during this song if it will be the
    // Nth music track. Only starts once — not restarted on partial completion.
    const moderationAfterSongs = Number(engineSettings.moderationAfterSongs);
    if (nextItem.kind === 'music'
        && engineSettings.moderationEnabled
        && moderationAfterSongs > 0
        && Number.isFinite(moderationAfterSongs)
        && (songCount + 1) >= moderationAfterSongs
        && pendingModerationPromise === null) {
      const songForMod = nextItem;
      pendingModerationPromise = buildModerationItem(songForMod)
        .then(item => { if (item) console.log('[engine] moderation pre-generated, ready'); return item; })
        .catch(err  => { console.warn('[engine] moderation pre-gen error:', err.message); return null; });
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
          if (returnItem.tmpFile) { try { unlinkSync(returnItem.tmpFile); } catch {} }
          console.log(`[engine] DONE [${returnItem.kind}] ${returnItem.artist} — ${returnItem.title} (killed=${itemWasKilled})`);
        }
      } else if (!resumedFromPause) {
        const { state } = getEpisodeState(nextItem);
        const isResume = Number(state.positionSeconds || 0) > 60 || Number(state.part || 1) > 1;
        const introItem = await buildPodcastIntroItem(nextItem, state, isResume);
        if (introItem && !paused && !shuttingDown) {
          currentItem = introItem;
          startedAt = Date.now();
          currentPlaybackStartSeconds = 0;
          playing = true;
          itemWasKilled = false;
          console.log(`[engine] PLAY [${introItem.kind}] ${introItem.artist} — ${introItem.title}`);
          broadcastStatus();
          await playItemOnAllOutputs(introItem);
          if (introItem.tmpFile) { try { unlinkSync(introItem.tmpFile); } catch {} }
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
      await playItemOnAllOutputs(nextItem, resumeStartSeconds > 0 ? { startSeconds: resumeStartSeconds } : {});
    }

    // Cleanup TTS temp file
    if (nextItem.tmpFile) { try { unlinkSync(nextItem.tmpFile); } catch {} }

    console.log(`[engine] DONE [${nextItem.kind}] ${nextItem.artist} — ${nextItem.title} (killed=${itemWasKilled})`);
    playing = false;

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
        await playItemOnAllOutputs(modItem);
        if (modItem.tmpFile) { try { unlinkSync(modItem.tmpFile); } catch {} }
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
    if (url.pathname === '/api/liked') {
      return send(res, 200, { liked: await loadLiked() });
    }
    if (url.pathname === '/api/blocked') {
      return send(res, 200, { blocked: loadBlockedRows() });
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
      if (paused) { paused = false; broadcastStatus(); }
      return send(res, 200, { ok: true, action: 'play', resume: pausedResumeItem });
    }

    if (url.pathname === '/api/toggle') {
      if (paused) {
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
      broadcastStatus();
      return send(res, 200, { ok: true, action: 'like', track: currentItem, totalLiked: liked.length });
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
        'musicSource',
        'wavlakePlaylistId',
        'wavlakePlaylistTitle',
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
        'musicBreakTracksAfterPodcast',
        'ttsProvider',
        'elevenLabsVoiceIdEn',
        'elevenLabsVoiceIdDe',
        'elevenLabsModelId',
        'elevenLabsVoiceSettings',
        'fishVoiceIdEn',
        'fishVoiceIdDe',
      ]) {
        if (Object.prototype.hasOwnProperty.call(body, key)) allowed[key] = body[key];
      }
      engineSettings = { ...engineSettings, ...allowed };
      if (Object.prototype.hasOwnProperty.call(allowed, 'musicSource')
          || Object.prototype.hasOwnProperty.call(allowed, 'wavlakePlaylistId')) {
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
      broadcastStatus();
      return send(res, 200, { ok: true, queue: engineSettings.podcastQueue });
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
