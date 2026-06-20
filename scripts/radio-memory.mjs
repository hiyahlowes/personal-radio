import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const DATA_DIR = process.env.RADIO_DATA_DIR || path.join(homedir(), '.config', 'personal-radio');
const EVENTS_FILE = process.env.PERSONAL_RADIO_EVENTS_FILE || path.join(DATA_DIR, 'radio-events.jsonl');
const MEMORY_FILE = process.env.PERSONAL_RADIO_MEMORY_FILE || path.join(DATA_DIR, 'radio-memory.json');

const MAX_RECENT_TRACKS = 80;
const MAX_PODCAST_SEGMENTS = 120;
const MAX_MODERATION_HISTORY = 80;
const MAX_CALL_INS = 200;
const MAX_TRANSITION_HISTORY = 240;

function nowIso() {
  return new Date().toISOString();
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function defaultMemory() {
  return {
    version: 1,
    trackStats: {},
    recentTracks: [],
    podcastSegments: [],
    transitions: [],
    dailyMemory: {},
    moderationHistory: [],
    callIns: [],
    updatedAt: nowIso(),
  };
}

function safeJsonParse(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

export function loadMemory() {
  try {
    if (!existsSync(MEMORY_FILE)) return defaultMemory();
    return { ...defaultMemory(), ...safeJsonParse(readFileSync(MEMORY_FILE, 'utf8'), defaultMemory()) };
  } catch {
    return defaultMemory();
  }
}

function saveMemory(memory) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const next = { ...memory, updatedAt: nowIso() };
    const tmp = `${MEMORY_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, MEMORY_FILE);
  } catch (err) {
    console.warn('[memory] save failed:', err.message);
  }
}

export function appendEvent(type, payload = {}) {
  const event = {
    id: randomUUID(),
    ts: nowIso(),
    type,
    ...payload,
  };
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`);
  } catch (err) {
    console.warn('[memory] event append failed:', err.message);
  }
  return event;
}

function itemKey(item = {}) {
  return item.id || item.liveUrl || `${item.artist || ''}::${item.title || ''}`;
}

function normalizedTrack(item = {}) {
  return {
    trackId: itemKey(item),
    title: item.title || item.name || '',
    artist: item.artist || '',
    albumTitle: item.albumTitle || '',
    liveUrl: item.liveUrl || '',
    duration: Number(item.duration || 0),
  };
}

function normalizedRadioItem(item = {}) {
  return {
    itemId: itemKey(item),
    kind: item.kind || 'unknown',
    title: item.title || item.name || '',
    artist: item.artist || '',
    albumTitle: item.albumTitle || '',
    liveUrl: item.liveUrl || '',
    duration: Number(item.duration || 0),
  };
}

function updateTrack(item, updater) {
  if (!item || item.kind !== 'music') return null;
  const memory = loadMemory();
  const base = normalizedTrack(item);
  const prev = memory.trackStats[base.trackId] || {
    ...base,
    playCount: 0,
    naturalFinishCount: 0,
    skipCount: 0,
    likeCount: 0,
    banCount: 0,
    lastPlayedAt: null,
    lastFinishedAt: null,
    lastSkippedAt: null,
    lastLikedAt: null,
    lastBannedAt: null,
  };
  const next = updater({ ...prev, ...base });
  memory.trackStats[base.trackId] = next;
  memory.updatedAt = nowIso();
  saveMemory(memory);
  return next;
}

export function recordTrackStarted(item) {
  appendEvent('track_started', { item: normalizedTrack(item) });
  return updateTrack(item, stat => ({
    ...stat,
    playCount: Number(stat.playCount || 0) + 1,
    lastPlayedAt: nowIso(),
  }));
}

export function recordTrackFinished(item, details = {}) {
  appendEvent('track_finished', { item: normalizedTrack(item), details });
  return updateTrack(item, stat => ({
    ...stat,
    naturalFinishCount: Number(stat.naturalFinishCount || 0) + (details.natural === false ? 0 : 1),
    lastFinishedAt: nowIso(),
  }));
}

export function recordTrackSkipped(item, details = {}) {
  appendEvent('track_skipped', { item: normalizedTrack(item), details });
  return updateTrack(item, stat => ({
    ...stat,
    skipCount: Number(stat.skipCount || 0) + 1,
    lastSkippedAt: nowIso(),
  }));
}

export function recordTrackLiked(item) {
  appendEvent('track_liked', { item: normalizedTrack(item) });
  return updateTrack(item, stat => ({
    ...stat,
    likeCount: Number(stat.likeCount || 0) + 1,
    lastLikedAt: nowIso(),
  }));
}

export function recordTrackBanned(item) {
  appendEvent('track_banned', { item: normalizedTrack(item) });
  return updateTrack(item, stat => ({
    ...stat,
    banCount: Number(stat.banCount || 0) + 1,
    lastBannedAt: nowIso(),
  }));
}

export function rememberRecentTrack(item, details = {}) {
  if (!item || item.kind !== 'music') return;
  const memory = loadMemory();
  memory.recentTracks = [
    { ...normalizedTrack(item), ts: nowIso(), ...details },
    ...(Array.isArray(memory.recentTracks) ? memory.recentTracks : []),
  ].slice(0, MAX_RECENT_TRACKS);
  saveMemory(memory);
}

function extractTopics(text = '') {
  const cleaned = String(text).toLowerCase();
  const candidates = [
    ['bitcoin', /bitcoin|btc|satoshi|lightning|wallet|mining/],
    ['ki', /\bki\b|künstliche intelligenz|ai\b|modell|llm/],
    ['politik', /politik|regierung|wahl|demokratie|partei|staat/],
    ['medien', /medien|journalismus|presse|öffentlichkeit/],
    ['wirtschaft', /wirtschaft|markt|geld|inflation|zins|rezession/],
    ['krieg', /krieg|militär|ukraine|gaza|israel|konflikt/],
    ['kultur', /kultur|kunst|musik|film|buch|literatur/],
    ['technik', /technik|software|computer|internet|plattform/],
    ['gesundheit', /gesundheit|medizin|krankheit|therapie/],
  ];
  return candidates.filter(([, rx]) => rx.test(cleaned)).map(([topic]) => topic);
}

function classifyMood(text = '') {
  const t = String(text).toLowerCase();
  if (/krieg|tod|angst|krise|schwer|traurig|hart|katastrophe|gewalt/.test(t)) return 'heavy';
  if (/witz|leicht|schön|freude|sommer|tanzen|locker|entspannt/.test(t)) return 'light';
  if (/bitcoin|politik|wirtschaft|technik|ki|medien/.test(t)) return 'thoughtful';
  return 'neutral';
}

export function recordPodcastSegment({ episodeKey, item, state, segment, context }) {
  const excerpt = String(context?.excerpt || '').slice(0, 1800);
  const topics = [...new Set(extractTopics(`${state?.showTitle || ''} ${state?.episodeTitle || ''} ${excerpt}`))];
  const mood = classifyMood(excerpt || state?.episodeTitle || '');
  const row = {
    id: randomUUID(),
    ts: nowIso(),
    episodeKey,
    showTitle: state?.showTitle || item?.artist || 'Podcast',
    episodeTitle: state?.episodeTitle || item?.title || 'Podcast',
    segmentStart: Number(segment?.startSeconds || 0),
    segmentEnd: Number(segment?.endSeconds || 0),
    part: Number(state?.part || 1),
    contextSource: context?.source || 'fallback',
    chapterTitle: context?.chapterTitle || '',
    excerpt,
    topics,
    mood,
  };
  appendEvent('podcast_segment_heard', row);
  const memory = loadMemory();
  memory.podcastSegments = [row, ...(memory.podcastSegments || [])].slice(0, MAX_PODCAST_SEGMENTS);
  const key = dayKey();
  const daily = memory.dailyMemory[key] || { date: key, topics: {}, moods: {}, summary: '', updatedAt: null };
  for (const topic of topics) daily.topics[topic] = Number(daily.topics[topic] || 0) + 1;
  daily.moods[mood] = Number(daily.moods[mood] || 0) + 1;
  daily.summary = buildDailySummary(daily, memory.podcastSegments.filter(s => String(s.ts).startsWith(key)));
  daily.updatedAt = nowIso();
  memory.dailyMemory[key] = daily;
  saveMemory(memory);
  return row;
}

function buildDailySummary(daily, segments) {
  const topics = Object.entries(daily.topics || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic]) => topic);
  const latest = segments.slice(0, 3).map(s => `${s.showTitle}: ${s.episodeTitle}`).join(' | ');
  if (!topics.length && !latest) return '';
  return [
    topics.length ? `Heute bisherige Themen: ${topics.join(', ')}.` : '',
    latest ? `Zuletzt gehoert: ${latest}.` : '',
  ].filter(Boolean).join(' ');
}

export function recordModeration({ purpose, item, scriptText, context = {} }) {
  const row = {
    id: randomUUID(),
    ts: nowIso(),
    purpose,
    itemId: itemKey(item || {}),
    itemTitle: item?.title || '',
    itemArtist: item?.artist || '',
    scriptText: String(scriptText || '').slice(0, 2000),
    topics: extractTopics(`${scriptText || ''} ${context?.excerpt || ''}`),
    callInIds: context?.callInIds || [],
  };
  appendEvent('moderation_spoken', row);
  const memory = loadMemory();
  memory.moderationHistory = [row, ...(memory.moderationHistory || [])].slice(0, MAX_MODERATION_HISTORY);
  saveMemory(memory);
  return row;
}

export function recordTransition({ fromItem = null, toItem = null, details = {} } = {}) {
  if (!toItem) return null;
  const from = fromItem ? normalizedRadioItem(fromItem) : null;
  const to = normalizedRadioItem(toItem);
  const transitionType = details.transitionType
    || details.reason
    || `${from?.kind || 'silence'}->${to.kind}`;
  const row = {
    id: randomUUID(),
    ts: nowIso(),
    from,
    to,
    transitionType,
    details: {
      phase: details.phase || '',
      reason: details.reason || '',
      detail: details.detail || '',
      fadeInSeconds: Number(details.fadeInSeconds || 0),
      fadeOutSeconds: Number(details.fadeOutSeconds || 0),
      fadeOutStartSeconds: Number(details.fadeOutStartSeconds || 0),
      startSeconds: Number(details.startSeconds || 0),
      resumeStartSeconds: Number(details.resumeStartSeconds || 0),
      silenceSinceLastEndSeconds: details.silenceSinceLastEndSeconds == null ? null : Number(details.silenceSinceLastEndSeconds || 0),
      podcastPart: details.podcastPart ?? null,
      podcastSegmentStartSeconds: details.podcastSegmentStartSeconds ?? null,
      podcastSegmentEndSeconds: details.podcastSegmentEndSeconds ?? null,
      podcastBreakSongsRemaining: details.podcastBreakSongsRemaining ?? null,
      usedPrecache: Boolean(details.usedPrecache),
      usedPregeneratedTts: Boolean(details.usedPregeneratedTts),
      outputs: Array.isArray(details.outputs) ? details.outputs.slice(0, 8) : [],
    },
  };
  appendEvent('transition_started', row);
  const memory = loadMemory();
  memory.transitions = [row, ...(Array.isArray(memory.transitions) ? memory.transitions : [])].slice(0, MAX_TRANSITION_HISTORY);
  saveMemory(memory);
  return row;
}

export function addCallIn({ text, mood = '', intent = '', source = 'remote' }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Call-in text is required');
  if (trimmed.length > 1000) throw new Error('Call-in text is too long');
  const row = {
    id: randomUUID(),
    ts: nowIso(),
    text: trimmed,
    mood: String(mood || '').trim(),
    intent: String(intent || '').trim(),
    inferredTopics: extractTopics(trimmed),
    inferredMood: classifyMood(trimmed),
    source,
    status: 'open',
    usedAt: null,
    archivedAt: null,
  };
  appendEvent('call_in_created', row);
  const memory = loadMemory();
  memory.callIns = [row, ...(memory.callIns || [])].slice(0, MAX_CALL_INS);
  saveMemory(memory);
  return row;
}

export function listCallIns({ status = '', limit = 50 } = {}) {
  const memory = loadMemory();
  return (memory.callIns || [])
    .filter(row => !status || row.status === status)
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

export function markCallInsUsed(ids = [], details = {}) {
  const idSet = new Set(ids.filter(Boolean));
  if (idSet.size === 0) return [];
  const memory = loadMemory();
  const used = [];
  memory.callIns = (memory.callIns || []).map(row => {
    if (!idSet.has(row.id) || row.status !== 'open') return row;
    const next = { ...row, status: 'used', usedAt: nowIso(), usedBy: details.purpose || 'moderation' };
    used.push(next);
    appendEvent('call_in_used', { id: row.id, details });
    return next;
  });
  saveMemory(memory);
  return used;
}

export function archiveCallIn(id, status = 'archived') {
  const memory = loadMemory();
  let updated = null;
  memory.callIns = (memory.callIns || []).map(row => {
    if (row.id !== id) return row;
    updated = { ...row, status, archivedAt: nowIso() };
    appendEvent('call_in_archived', { id, status });
    return updated;
  });
  saveMemory(memory);
  return updated;
}

export function memorySnapshot({ trackId = '', openCallInLimit = 2 } = {}) {
  const memory = loadMemory();
  const today = memory.dailyMemory[dayKey()] || null;
  const openCallIns = (memory.callIns || []).filter(c => c.status === 'open').slice(0, openCallInLimit);
  return {
    today,
    trackStats: trackId ? memory.trackStats?.[trackId] || null : null,
    recentTracks: (memory.recentTracks || []).slice(0, 8),
    recentPodcastSegments: (memory.podcastSegments || []).slice(0, 5),
    recentTransitions: (memory.transitions || []).slice(0, 12),
    recentModerations: (memory.moderationHistory || []).slice(0, 5),
    openCallIns,
  };
}
