/**
 * useEngineMode — remote control for the Pi radio engine.
 *
 * When VITE_RADIO_MODE=remote (or ?remote=1 in the URL) this hook polls
 * /api/status and subscribes to /api/events SSE so that RadioPage can
 * display live engine state without playing any audio itself.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import type { RadioItem } from '@/contexts/RadioContext';
import type { WavlakeTrack } from '@/hooks/useWavlakeTracks';
import type { PodcastEpisode, PodcastFeed } from '@/hooks/usePodcastFeeds';

export function isRadioRemoteMode(): boolean {
  if (import.meta.env.VITE_RADIO_MODE === 'remote') return true;
  if (import.meta.env.VITE_RADIO_REMOTE_MODE === 'true') return true;
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return window.location.pathname === '/remote' || params.get('remote') === '1';
}

export interface EngineOutputState {
  playing: boolean;
  error: string | null;
  sink: string;
}

export interface EngineCurrentItem {
  kind: 'music' | 'tts' | 'podcast' | string;
  id?: string;
  title?: string;
  artist?: string;
  artworkUrl?: string;
  liveUrl?: string;
  duration?: number;
  albumTitle?: string;
}

export interface EngineStatus {
  playing: boolean;
  paused: boolean;
  currentItem: EngineCurrentItem | null;
  elapsedSeconds: number;
  playbackStartSeconds?: number;
  pausedResumeItem?: {
    item: EngineCurrentItem;
    positionSeconds: number;
    savedAt: string;
  } | null;
  queueLength: number;
  outputs: Record<string, EngineOutputState>;
  queue?: EngineCurrentItem[];
  settings?: EngineSettings;
  volumes?: EngineVolumes;
  podcastQueue?: PodcastEpisode[];
  podcastState?: EnginePodcastState;
  listenerState?: EngineListenerState;
  songCount?: number;
}

export interface EngineListenerState {
  mode: 'unknown' | 'active' | 'grace' | 'suspended' | 'disabled' | string;
  activeListeners: number;
  activeOutputs: string[];
  outputDetails?: Array<{
    name: string;
    sink: string;
    kind: 'physical' | 'stream' | string;
    sinkAvailable: boolean;
    clients?: number;
    active: boolean;
    reason: string;
  }>;
  liveStreamClients: number | null;
  lastCheckedAt: string | null;
  lastHeardAt: string | null;
  graceStartedAt: string | null;
  suspendedAt: string | null;
  lastResumedAt: string | null;
  lastSuspendDurationSeconds: number;
  silenceDurationSeconds: number;
  resumeWillStartNewSession: boolean;
  autoSuspendWhenNoListeners: boolean;
  noListenerGraceSeconds: number;
  newSessionAfterMinutes: number;
  pendingSessionIntro?: boolean;
  deferredResumeKind?: string | null;
  reason: string | null;
}

export interface EnginePodcastState {
  isPlaying: boolean;
  sessionActive?: boolean;
  currentEpisodeKey?: string | null;
  showTitle: string | null;
  episodeTitle: string | null;
  currentPositionSeconds: number;
  durationSeconds: number;
  part: number;
  segmentStartSeconds: number | null;
  segmentEndSeconds: number | null;
  nextBreakTargetSeconds: number | null;
  hasTranscript: boolean;
  hasChapters: boolean;
  lastSegmentContextSource: 'transcript' | 'chapter' | 'stt' | 'fallback' | string | null;
  willResume: boolean;
  breakSongsRemaining: number;
  lastSegment?: {
    episodeKey: string;
    showTitle: string;
    episodeTitle: string;
    part: number;
    startSeconds: number;
    endSeconds: number;
    plannedEndSeconds: number;
    contextSource: string;
    chapterTitle?: string;
    completed: boolean;
    skipped: boolean;
    savedAt: string;
  } | null;
}

export interface EngineSettings {
  satStreamingEnabled: boolean;
  boostAmountSats: number;
  satRatePerMinute: number;
  supportPREnabled: boolean;
  prSplitPercent: number;
  moderationEnabled: boolean;
  moderationAfterSongs: number;
  musicSource: 'topCharts' | 'wavlakePlaylist' | 'prLikedSongs';
  wavlakePlaylistId: string;
  wavlakePlaylistTitle: string;
  wavlakePlaylists: Array<{ id: string; title?: string }>;
  podcastAfterSongs: number;
  podcastFeedUrl: string;
  podcastFeeds: PodcastFeed[];
  podcastQueue: PodcastEpisode[];
  podcastQueueRefreshedAt?: string;
  podcastsEnabled: boolean;
  podcastSegmentMinMinutes: number;
  podcastSegmentMaxMinutes: number;
  podcastSttFallbackEnabled: boolean;
  podcastPreferTranscriptChapters: boolean;
  podcastTranscriptPrefetchEnabled: boolean;
  podcastTranscriptPrefetchLimit: number;
  podcastTranscriptProvider: 'assemblyai' | 'elevenlabs' | string;
  musicBreakTracksAfterPodcast: number;
  ttsProvider: 'elevenlabs' | 'fish';
  elevenLabsVoiceIdEn: string;
  elevenLabsVoiceIdDe: string;
  elevenLabsModelId: string;
  elevenLabsVoiceSettings: {
    stability: number;
    similarity_boost: number;
    style: number;
    use_speaker_boost: boolean;
  };
  fishVoiceIdEn: string;
  fishVoiceIdDe: string;
  autoSuspendWhenNoListeners: boolean;
  noListenerGraceSeconds: number;
  newSessionAfterMinutes: number;
  resumeWithLikedSong: boolean;
  sessionIntroAfterFirstSong: boolean;
}

export type EngineVolumes = Record<string, { sink: string; volume: number | null; muted?: boolean }>;

export interface EngineCallIn {
  id: string;
  ts: string;
  text: string;
  mood?: string;
  intent?: string;
  inferredTopics?: string[];
  inferredMood?: string;
  status: 'open' | 'used' | 'archived' | string;
  usedAt?: string | null;
  archivedAt?: string | null;
}

/** Map an engine music item → RadioItem so RadioPage can render it unchanged. */
function engineItemToRadioItem(item: EngineCurrentItem | null | undefined): RadioItem | null {
  if (!item) return null;
  if (item.kind === 'music') {
    return {
      kind: 'music',
      track: {
        id:         item.id         ?? '',
        name:       item.title      ?? '',
        artist:     item.artist     ?? '',
        albumTitle: item.albumTitle ?? '',
        artworkUrl: item.artworkUrl ?? '',
        liveUrl:    item.liveUrl    ?? '',
        duration:   item.duration   ?? 0,
        artistId:   '',
        albumId:    '',
        avatarUrl:  '',
      },
    } as RadioItem;
  }
  if (item.kind === 'podcast') {
    return {
      kind: 'podcast',
      episode: {
        id: item.id ?? item.liveUrl ?? '',
        feedTitle: item.artist ?? 'Podcast',
        title: item.title ?? 'Podcast',
        audioUrl: item.liveUrl ?? '',
        duration: item.duration ?? 0,
        description: '',
        pubDate: '',
      },
    } as RadioItem;
  }
  if (item.kind === 'moderation' || item.kind === 'tts') {
    return {
      kind: 'moderation',
      title: item.title ?? 'Moderation',
      artist: item.artist ?? 'Radio Host',
      duration: item.duration ?? 0,
    } as RadioItem;
  }
  return null;
}

function engineItemToTrack(item: EngineCurrentItem): WavlakeTrack {
  return {
    id: item.id ?? item.liveUrl ?? `${item.artist ?? ''}-${item.title ?? ''}`,
    name: item.title ?? '',
    artist: item.artist ?? '',
    albumTitle: item.albumTitle ?? '',
    artworkUrl: item.artworkUrl ?? '',
    liveUrl: item.liveUrl ?? '',
    duration: item.duration ?? 0,
    artistId: '',
    albumId: '',
    avatarUrl: '',
  };
}

export function useEngineMode() {
  const isRemote = isRadioRemoteMode();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [queue, setQueue] = useState<WavlakeTrack[]>([]);
  const [podcastQueue, setPodcastQueue] = useState<PodcastEpisode[]>([]);
  const [settings, setSettings] = useState<EngineSettings | null>(null);
  const [volumes, setVolumes] = useState<EngineVolumes | null>(null);
  const [callIns, setCallIns] = useState<EngineCallIn[]>([]);
  const sseRef  = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isRemote) return;

    const fetchStatus = () =>
      fetch('/api/status')
        .then(r => r.json())
        .then((s: EngineStatus) => {
          setStatus(s);
          if (Array.isArray(s.queue)) setQueue(s.queue.filter(i => i.kind === 'music').map(engineItemToTrack));
          if (Array.isArray(s.podcastQueue)) setPodcastQueue(s.podcastQueue);
          if (s.settings) setSettings(s.settings);
          if (s.volumes) setVolumes(s.volumes);
        })
        .catch(() => {}); // swallow network errors — SSE will recover

    const fetchQueue = () =>
      fetch('/api/queue')
        .then(r => r.json())
        .then((q: { queue?: EngineCurrentItem[] }) => {
          setQueue((q.queue ?? []).filter(i => i.kind === 'music').map(engineItemToTrack));
        })
        .catch(() => {});

    fetchStatus(); // initial load
    fetchQueue();
    fetch('/api/call-ins?status=open')
      .then(r => r.json())
      .then((out: { callIns?: EngineCallIn[] }) => {
        if (Array.isArray(out.callIns)) setCallIns(out.callIns);
      })
      .catch(() => {});

    // Fallback polling — catches missed SSE events
    pollRef.current = setInterval(() => { fetchStatus(); fetchQueue(); }, 3000);

    // SSE for near-instant state updates
    const es = new EventSource('/api/events');
    sseRef.current = es;
    es.addEventListener('status', (e: Event) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as EngineStatus;
        setStatus(data);
        if (Array.isArray(data.queue)) setQueue(data.queue.filter(i => i.kind === 'music').map(engineItemToTrack));
        if (Array.isArray(data.podcastQueue)) setPodcastQueue(data.podcastQueue);
        if (data.settings) setSettings(data.settings);
        if (data.volumes) setVolumes(data.volumes);
      } catch {
        // Ignore malformed SSE payloads; polling will refresh state.
      }
    });
    es.onerror = () => {
      // SSE reconnects automatically; we rely on polling as backstop
    };

    return () => {
      clearInterval(pollRef.current ?? undefined);
      es.close();
      sseRef.current = null;
    };
  }, [isRemote]);

  const apiPost = useCallback((path: string, body?: unknown) => {
    fetch(path, {
      method: 'POST',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => {});
  }, []);

  const refreshSettings = useCallback(async () => {
    if (!isRemote) return null;
    const r = await fetch('/api/settings');
    const s = await r.json() as EngineSettings;
    setSettings(s);
    return s;
  }, [isRemote]);

  const saveSettings = useCallback(async (patch: Partial<EngineSettings>) => {
    if (!isRemote) return null;
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const s = await r.json() as EngineSettings;
    setSettings(s);
    return s;
  }, [isRemote]);

  const refreshVolumes = useCallback(async () => {
    if (!isRemote) return null;
    const r = await fetch('/api/volume');
    const v = await r.json() as EngineVolumes;
    setVolumes(v);
    return v;
  }, [isRemote]);

  const refreshCallIns = useCallback(async (status = 'open') => {
    if (!isRemote) return [];
    const r = await fetch(`/api/call-ins?status=${encodeURIComponent(status)}`);
    const out = await r.json() as { callIns?: EngineCallIn[] };
    const rows = Array.isArray(out.callIns) ? out.callIns : [];
    if (status === 'open') setCallIns(rows);
    return rows;
  }, [isRemote]);

  const submitCallIn = useCallback(async (text: string, patch: { mood?: string; intent?: string } = {}) => {
    if (!isRemote) return null;
    const r = await fetch('/api/call-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...patch, source: 'remote' }),
    });
    const out = await r.json() as { ok?: boolean; callIn?: EngineCallIn; error?: string };
    if (!r.ok || out.ok === false || !out.callIn) throw new Error(out.error || 'Call-in failed');
    setCallIns(prev => [out.callIn!, ...prev].slice(0, 20));
    return out.callIn;
  }, [isRemote]);

  const archiveCallIn = useCallback(async (id: string) => {
    if (!isRemote) return null;
    const r = await fetch('/api/call-ins/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const out = await r.json() as { ok?: boolean; callIn?: EngineCallIn };
    setCallIns(prev => prev.filter(row => row.id !== id));
    return out.callIn ?? null;
  }, [isRemote]);

  const savePodcastQueue = useCallback(async (nextQueue: PodcastEpisode[]) => {
    if (!isRemote) return null;
    setPodcastQueue(nextQueue);
    const r = await fetch('/api/podcast-queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queue: nextQueue }),
    });
    const out = await r.json() as { queue?: PodcastEpisode[] };
    if (Array.isArray(out.queue)) setPodcastQueue(out.queue);
    return out.queue ?? nextQueue;
  }, [isRemote]);

  const refreshPodcastQueue = useCallback(async () => {
    if (!isRemote) return null;
    const r = await fetch('/api/podcast-refresh', { method: 'POST' });
    const out = await r.json() as { ok?: boolean; queue?: PodcastEpisode[]; error?: string };
    if (!r.ok || out.ok === false) throw new Error(out.error || 'Podcast refresh failed');
    if (Array.isArray(out.queue)) setPodcastQueue(out.queue);
    await refreshSettings();
    return out.queue ?? [];
  }, [isRemote, refreshSettings]);

  const playPodcast = useCallback((episode: PodcastEpisode) => {
    apiPost('/api/play-podcast', { episode });
  }, [apiPost]);

  return {
    isRemote,
    status,
    queue,
    podcastQueue,
    callIns,
    settings,
    volumes,
    engineNowPlaying: engineItemToRadioItem(status?.currentItem),
    skip:   () => apiPost('/api/skip'),
    play:   () => apiPost('/api/play'),
    pause:  () => apiPost('/api/pause'),
    toggle: () => apiPost('/api/toggle'),
    like:   () => apiPost('/api/like-current'),
    ban:    () => apiPost('/api/ban-current'),
    boost:  (amountSats?: number) => apiPost('/api/boost-current', { amountSats }),
    setSatStreaming: (enabled: boolean) => apiPost('/api/sat-streaming', { enabled }),
    setVolume: (output: string, volume: number) => apiPost('/api/volume', { output, volume }),
    skipPodcastSegment: () => apiPost('/api/skip-podcast-segment'),
    abandonPodcast: () => apiPost('/api/abandon-podcast'),
    savePodcastQueue,
    refreshPodcastQueue,
    playPodcast,
    refreshSettings,
    saveSettings,
    refreshVolumes,
    refreshCallIns,
    submitCallIn,
    archiveCallIn,
  };
}
