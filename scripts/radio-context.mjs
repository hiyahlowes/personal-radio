import { memorySnapshot } from './radio-memory.mjs';

function itemKey(item = {}) {
  return item.id || item.liveUrl || `${item.artist || ''}::${item.title || ''}`;
}

function formatCallIns(callIns = []) {
  if (!callIns.length) return { text: '', ids: [] };
  const lines = callIns.map((call, index) => {
    const extra = [
      call.intent ? `Wunsch: ${call.intent}` : '',
      call.mood ? `Stimmung: ${call.mood}` : '',
      call.inferredTopics?.length ? `Themen: ${call.inferredTopics.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    return `${index + 1}. "${call.text}"${extra ? ` (${extra})` : ''}`;
  });
  return {
    text: [
      'Offene Call-Ins vom Hoerer. Sie duerfen die naechste Moderation beeinflussen, aber nicht erzwungen wirken:',
      ...lines,
    ].join('\n'),
    ids: callIns.map(call => call.id),
  };
}

function formatDaily(today) {
  if (!today) return '';
  const topics = Object.entries(today.topics || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, count]) => `${topic} (${count})`);
  const moods = Object.entries(today.moods || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([mood, count]) => `${mood} (${count})`);
  return [
    today.summary ? `Tagesgedaechtnis: ${today.summary}` : '',
    topics.length ? `Podcast-Themen heute: ${topics.join(', ')}.` : '',
    moods.length ? `Stimmung der Podcast-Themen heute: ${moods.join(', ')}.` : '',
  ].filter(Boolean).join('\n');
}

function formatTrackStats(stats) {
  if (!stats) return '';
  const facts = [];
  const plays = Number(stats.playCount || 0);
  const likes = Number(stats.likeCount || 0);
  const skips = Number(stats.skipCount || 0);
  if (plays >= 5) facts.push(`Dieser Song lief schon ${plays} Mal im Radio.`);
  else if (plays >= 2) facts.push(`Dieser Song kam schon ${plays} Mal vor.`);
  if (likes > 0) facts.push(`Der Hoerer hat diesen Song ${likes} Mal geliked.`);
  if (skips >= 2) facts.push(`Der Song wurde ${skips} Mal geskippt; vorsichtig positiv formulieren.`);
  if (stats.lastPlayedAt) facts.push(`Zuletzt gespielt: ${stats.lastPlayedAt}.`);
  return facts.length ? `Song-Gedaechtnis:\n- ${facts.join('\n- ')}` : '';
}

function formatRecentPodcasts(segments = []) {
  if (!segments.length) return '';
  const lines = segments.slice(0, 3).map(seg => {
    const topics = seg.topics?.length ? ` Themen: ${seg.topics.join(', ')}.` : '';
    return `- ${seg.showTitle}: ${seg.episodeTitle} (${Math.round(seg.segmentStart / 60)}-${Math.round(seg.segmentEnd / 60)} min). Stimmung: ${seg.mood}.${topics}`;
  });
  return `Zuletzt gehoerte Podcast-Abschnitte:\n${lines.join('\n')}`;
}

function formatModerationGuard(history = []) {
  const scripts = history
    .map(row => String(row.scriptText || '').trim())
    .filter(Boolean)
    .slice(0, 3);
  if (!scripts.length) return '';
  return [
    'Wiederholungsvermeidung: Wiederhole nicht die Formulierungen der letzten Moderationen.',
    ...scripts.map((script, index) => `${index + 1}. ${script.slice(0, 220)}`),
  ].join('\n');
}

export function buildMusicModerationContext(item) {
  const snapshot = memorySnapshot({ trackId: itemKey(item), openCallInLimit: 2 });
  const callIns = formatCallIns(snapshot.openCallIns);
  const sections = [
    formatTrackStats(snapshot.trackStats),
    formatDaily(snapshot.today),
    formatRecentPodcasts(snapshot.recentPodcastSegments),
    callIns.text,
    formatModerationGuard(snapshot.recentModerations),
  ].filter(Boolean);
  return {
    promptText: sections.length ? `\n\nLokaler Radio-Memory-Kontext:\n${sections.join('\n\n')}` : '',
    callInIds: callIns.ids,
  };
}

export function buildPodcastModerationContext({ item, episodeState, segment, context }) {
  const snapshot = memorySnapshot({ trackId: '', openCallInLimit: 2 });
  const callIns = formatCallIns(snapshot.openCallIns);
  const sections = [
    formatDaily(snapshot.today),
    formatRecentPodcasts(snapshot.recentPodcastSegments),
    callIns.text,
    formatModerationGuard(snapshot.recentModerations),
    `Aktueller Podcast-Abschnitt: ${episodeState?.showTitle || item?.artist || 'Podcast'} / ${episodeState?.episodeTitle || item?.title || 'Podcast'} von ${Math.round((segment?.startSeconds || 0) / 60)} bis ${Math.round((segment?.endSeconds || 0) / 60)} min. Kontextquelle: ${context?.source || 'fallback'}.`,
  ].filter(Boolean);
  return {
    promptText: sections.length ? `\n\nLokaler Radio-Memory-Kontext:\n${sections.join('\n\n')}` : '',
    callInIds: callIns.ids,
  };
}

export function buildPodcastIntroContext({ item, episodeState, isResume }) {
  const snapshot = memorySnapshot({ openCallInLimit: 1 });
  const callIns = formatCallIns(snapshot.openCallIns);
  const sections = [
    formatDaily(snapshot.today),
    formatRecentPodcasts(snapshot.recentPodcastSegments),
    isResume ? 'Dies ist eine Rueckkehr in eine bereits begonnene Episode.' : '',
    callIns.text,
    `Podcast: ${episodeState?.showTitle || item?.artist || 'Podcast'} / ${episodeState?.episodeTitle || item?.title || 'Podcast'}.`,
  ].filter(Boolean);
  return {
    promptText: sections.length ? `\n\nLokaler Radio-Memory-Kontext:\n${sections.join('\n\n')}` : '',
    callInIds: callIns.ids,
  };
}
