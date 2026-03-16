import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Howl } from 'howler';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
  type DraggableStateSnapshot,
  type DraggableProvided,
} from '@hello-pangea/dnd';

import { useWavlakeTracks, fetchAmbientBridgePool, type WavlakeTrack, GENRES, TOP_CHARTS_ID } from '@/hooks/useWavlakeTracks';
import { usePodcastEpisodes, useSingleFeedEpisodes, getStoredFeeds, type PodcastEpisode, type PodcastFeed } from '@/hooks/usePodcastFeeds';
import { useRadioModerator, type ResumeContext } from '@/hooks/useRadioModerator';
import { usePodcastSegmenter } from '@/hooks/usePodcastSegmenter';
import { useGenreSelection } from '@/hooks/useGenreSelection';
import { useLikedTracks } from '@/hooks/useLikedTracks';
import { usePodcastHistory } from '@/hooks/usePodcastHistory';
import { useMusicHistory } from '@/hooks/useMusicHistory';
import { useListenerMemory } from '@/hooks/useListenerMemory';
import { useRadioContext } from '@/contexts/RadioContext';
import { Skeleton } from '@/components/ui/skeleton';
import { getStoredName } from '@/pages/SetupPage';

// ─── Play-count helpers ────────────────────────────────────────────────────────
/** In-place Fisher-Yates shuffle; returns the same array. */
function fisherYates<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Re-order tracks so unplayed ones come first, played ones sorted by count.
 * The currently-playing track (if any) is pinned at index 0.
 */
function applyPlayCountBias(
  tracks: WavlakeTrack[],
  playCounts: Record<string, number>,
  currentId?: string,
): WavlakeTrack[] {
  const current  = currentId ? tracks.find(t => t.id === currentId) : undefined;
  const rest     = tracks.filter(t => t !== current);
  const unplayed = fisherYates(rest.filter(t => !(playCounts[t.id] ?? 0)));
  const played   = rest
    .filter(t => !!(playCounts[t.id] ?? 0))
    .sort((a, b) => (playCounts[a.id] ?? 0) - (playCounts[b.id] ?? 0));
  return current ? [current, ...unplayed, ...played] : [...unplayed, ...played];
}

// ─── RadioItem union ─────────────────────────────────────────────────────────
type RadioItem =
  | { kind: 'music';   track:   WavlakeTrack    }
  | { kind: 'podcast'; episode: PodcastEpisode  };

// ─── Volume ramping via setInterval ──────────────────────────────────────────
const DUCK_LEVEL     = 0.08;
const CROSSFADE_SECS = 3;    // seconds before track end to begin crossfade
const TICK_MS        = 40;   // ~25 steps/s — smooth enough

// ─── Web Audio API — GainNode volume control (iOS-safe) ───────────────────────
// ── iOS audio unlock (Blake Kus pattern) ──────────────────────────────────────
// Warms the audio session on the first touchend anywhere on the page.
// Based on: https://gist.github.com/kus/3f01d60569eeadefe3a1
const _warmIOSAudio = () => {
  const AudioCtxCtor = window.AudioContext ?? (window as any).webkitAudioContext as typeof AudioContext | undefined;
  if (!AudioCtxCtor) return;
  const ctx    = new AudioCtxCtor();
  const buffer = ctx.createBuffer(1, 1, 22050);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
  document.removeEventListener('touchend', _warmIOSAudio);
  console.log('[iOS] AudioContext warmed on first touch');
};
document.addEventListener('touchend', _warmIOSAudio);

function rampVolume(
  audio: HTMLAudioElement,
  target: number,
  durationMs: number,
  onDone?: () => void,
): () => void {
  const start = audio.volume;
  const steps = Math.max(1, Math.round(durationMs / TICK_MS));
  const delta = (target - start) / steps;
  let   count = 0;
  const id    = setInterval(() => {
    count++;
    audio.volume = count >= steps
      ? target
      : Math.max(0, Math.min(1, start + delta * count));
    if (count >= steps) { clearInterval(id); onDone?.(); }
  }, TICK_MS);
  console.log(`[Ramp] ${start.toFixed(2)} → ${target.toFixed(2)} over ${durationMs}ms`);
  return () => clearInterval(id);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Pre-load the podcast-intro jingle so it plays instantly when needed.
// The same element is reused (currentTime reset) on each call.
const _jingleAudio = new Audio('/podcast-intro.mp3');
_jingleAudio.preload = 'auto';
_jingleAudio.load();
console.log('[Preload] jingles cached');


/**
 * Play a jingle at full volume and resolve when it ends.
 * For '/podcast-intro.mp3' the preloaded singleton is reused so playback
 * starts instantly. Other paths get a fresh Audio element.
 * Errors are swallowed so a missing file never stalls the radio loop.
 */
function playJingle(src: string): Promise<void> {
  return new Promise<void>(resolve => {
    const jingle = src === '/podcast-intro.mp3' ? _jingleAudio : new Audio(src);
    if (src === '/podcast-intro.mp3') jingle.currentTime = 0;
    jingle.volume = 1.0;
    jingle.addEventListener('ended', () => resolve(), { once: true });
    jingle.addEventListener('error', () => resolve(), { once: true });
    jingle.play().catch(() => resolve());
  });
}
function fmt(s: number) {
  if (!isFinite(s) || s < 0) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ─── Queue persistence ────────────────────────────────────────────────────────
const QUEUE_TRACKS_KEY   = 'pr:queue-tracks';
const QUEUE_EPISODES_KEY = 'pr:queue-episodes';
const QUEUE_IDX_KEY      = 'pr:queue-idx';

function saveQueue(tracks: WavlakeTrack[], episodes: PodcastEpisode[], idx: number) {
  try {
    localStorage.setItem(QUEUE_TRACKS_KEY,   JSON.stringify(tracks));
    localStorage.setItem(QUEUE_EPISODES_KEY, JSON.stringify(episodes));
    localStorage.setItem(QUEUE_IDX_KEY,      String(idx));
  } catch { /* quota exceeded — ignore */ }
}

function loadQueue(): { tracks: WavlakeTrack[]; episodes: PodcastEpisode[]; idx: number } {
  try {
    const t  = localStorage.getItem(QUEUE_TRACKS_KEY);
    const e  = localStorage.getItem(QUEUE_EPISODES_KEY);
    const i  = localStorage.getItem(QUEUE_IDX_KEY);
    const tracks   = t ? (JSON.parse(t) as WavlakeTrack[])   : [];
    const episodes = e ? (JSON.parse(e) as PodcastEpisode[]) : [];
    const idx      = i ? Math.max(0, parseInt(i, 10))         : 0;
    return { tracks: Array.isArray(tracks) ? tracks : [], episodes: Array.isArray(episodes) ? episodes : [], idx };
  } catch {
    return { tracks: [], episodes: [], idx: 0 };
  }
}

// ─── Podcast position persistence ────────────────────────────────────────────
const PODCAST_POSITION_KEY = 'pr:podcast-position';

function savePodcastPosition(episodeId: string, currentTime: number): void {
  try {
    const raw = localStorage.getItem(PODCAST_POSITION_KEY);
    const positions: Record<string, number> = raw ? JSON.parse(raw) : {};
    positions[episodeId] = currentTime;
    localStorage.setItem(PODCAST_POSITION_KEY, JSON.stringify(positions));
  } catch { /* quota exceeded — ignore */ }
}

function loadPodcastPosition(episodeId: string): number {
  try {
    const raw = localStorage.getItem(PODCAST_POSITION_KEY);
    if (!raw) return 0;
    const positions = JSON.parse(raw) as Record<string, number>;
    return positions[episodeId] ?? 0;
  } catch { return 0; }
}

// ─── Portal-aware drag clone helper ──────────────────────────────────────────
// backdrop-filter on .glass-card creates a new stacking context that traps
// position:fixed elements — which is exactly how @hello-pangea/dnd positions
// the drag clone. We escape by portalling the dragging element into document.body.
//
// Usage: wrap the content div that gets provided.draggableProps and provided.innerRef
// with this component. Pass dragHandleProps separately to whichever child element
// should be the handle (usually a grip icon).
function PortalAware({
  provided,
  snapshot,
  className,
  children,
}: {
  provided: DraggableProvided;
  snapshot: DraggableStateSnapshot;
  className?: string;
  children: React.ReactNode;
}) {
  const el = (
    <div
      ref={provided.innerRef}
      {...provided.draggableProps}
      className={className}
    >
      {children}
    </div>
  );
  return snapshot.isDragging ? createPortal(el, document.body) : el;
}

// ─── Component ────────────────────────────────────────────────────────────────
export function RadioPage() {
  const navigate  = useNavigate();

  // Always read name from localStorage — it's the single source of truth.
  // The URL ?name= param is only a legacy hint from the old welcome page flow
  // and must NOT take precedence, or changing the name in Settings has no effect.
  const [name, setName] = useState(() => getStoredName() || 'Listener');
  const firstName = name.split(' ')[0];

  // Re-read name from localStorage whenever the page becomes visible again
  // (e.g. returning from Settings after changing the name there).
  useEffect(() => {
    const refresh = () => {
      const stored = getStoredName();
      if (stored) setName(stored);
    };
    // visibilitychange fires when tab becomes active; focus fires on window refocus
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const { selectedIds, toggle, selectAll, isAllSelected, isTopCharts } = useGenreSelection();
  const { data: tracks = [], isLoading, isError } = useWavlakeTracks(selectedIds);

  // ── Podcast feeds — re-read from localStorage on visibility change ─────────
  // getStoredFeeds() is called once at mount; we keep it in state so that
  // returning from the Settings page (visibilitychange / focus) causes the
  // queryKey to update and React Query to re-fetch with the new feed list.
  const [storedFeeds, setStoredFeeds] = useState(getStoredFeeds);
  useEffect(() => {
    const refresh = () => setStoredFeeds(getStoredFeeds());
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    // Also listen for the custom event dispatched by SettingsPage on feed save
    window.addEventListener('pr:feeds-updated', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pr:feeds-updated', refresh);
    };
  }, []);

  const {
    data: episodes = [],
    refetch: refetchEpisodes,
    isFetching: episodesFetching,
  } = usePodcastEpisodes(storedFeeds);

  const moderator = useRadioModerator();
  const likedTracks    = useLikedTracks();
  const podcastHistory = usePodcastHistory();
  const musicHistory   = useMusicHistory();
  const listenerMemory = useListenerMemory(getStoredName() || 'Listener');

  // ── UI state ──────────────────────────────────────────────────────────────
  const [idx, setIdx]         = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuf]   = useState(false);
  const [currentTime, setCT]  = useState(0);
  const [duration, setDur]    = useState(0);
  const durationRef           = useRef(0);
  const [volume, setVol]      = useState(0.9);
  const [muted, setMuted]     = useState(false);

  // ── Draggable / reorderable local copies of playlist & queue ──────────────
  // Initialise from persisted queue so content appears instantly on page return,
  // before the Wavlake / RSS queries resolve. API data overwrites these on load.
  // Shuffle persisted tracks immediately so every session starts with a fresh order
  const [orderedTracks, setOrderedTracks] = useState<WavlakeTrack[]>(() => {
    const { tracks } = loadQueue();
    return tracks.length > 0 ? fisherYates([...tracks]) : tracks;
  });
  const [orderedEpisodes, setOrderedEpisodes] = useState<PodcastEpisode[]>(() => loadQueue().episodes);

  // ── Episode management panel ──────────────────────────────────────────────
  const [expandedFeed, setExpandedFeed] = useState<string | null>(null);

  const segmenter = usePodcastSegmenter();
  const radioCtx  = useRadioContext();

  // Audio elements and core loop refs come from RadioContext so they survive
  // route changes (e.g. navigating to Settings and back).
  const audioRef    = radioCtx.audioRef;
  const podAudioRef = radioCtx.podAudioRef;
  const howlRef     = useRef<Howl | null>(null);
  const runningRef  = radioCtx.runningRef;
  const greetedRef  = radioCtx.greetedRef;
  const idxRef      = radioCtx.idxRef;
  const loopGenRef  = radioCtx.loopGenRef;

  // nowPlaying lives in RadioContext so it survives navigation to Settings and back.
  const nowPlaying    = radioCtx.nowPlaying;
  const setNowPlaying = radioCtx.setNowPlaying;
  const nowPlayingRef = radioCtx.nowPlayingRef;

  const nextAudioRef     = radioCtx.nextAudioRef;

  const cancelRampRef          = useRef<(() => void) | null>(null);
  const cancelNextRampRef      = useRef<(() => void) | null>(null);
  // Non-null when the user paused mid-podcast; advanceLoop resumes from here on next play.
  const resumePodcastEpisodeRef = useRef<PodcastEpisode | null>(null);
  // Timestamp of last podcast position save (throttle to every 5 s).
  const lastPodSaveRef          = useRef(0);
  // Set true after a crossfade completes so the loop top skips re-loading audio
  const crossfadeActiveRef = useRef(false);
  // Set true while the podcast transition ramp sequence is running so the generic
  // duck effect does not interfere (we own the volume during that window).
  const podcastTransitionRef = useRef(false);
  // Set true when the user resumes music that was paused mid-track so the loop
  // skips the src reload and just calls play() from the current position.
  const resumeMusicRef = useRef(false);
  const tracksRef          = useRef<WavlakeTrack[]>([]);
  const ambientBridgeRef   = useRef<WavlakeTrack[]>([]); // separate bridge pool, never in playlist
  const silentCountRef   = useRef(0);
  const silentBudgetRef  = useRef(randInt(2, 3)); // 2-3 music tracks before podcast
  const recentTracksRef  = useRef<WavlakeTrack[]>([]);
  const episodesRef      = useRef<PodcastEpisode[]>([]);
  const podcastIdxRef    = useRef(0); // cycles through episodes
  const moderatorRef       = useRef(moderator);
  const listenerMemoryRef  = useRef(listenerMemory);
  const nameRef            = useRef(name);
  const volumeRef        = useRef(0.9);
  const mutedRef         = useRef(false);
  // Set to true by jumpTo() so the next loop iteration knows to say a brief
  // "skipping ahead" line instead of the full track intro sequence.
  const skipRef          = useRef(false);
  // Ref-stable callback used inside advanceLoop (stable closure) to mark
  // episodes as played without adding podcastHistory to its dependency array.
  const markPlayedRef      = useRef<(id: string) => void>(() => {});
  const markMusicPlayedRef = useRef<(id: string) => void>(() => {});

  // Sync refs to latest state/props
  useEffect(() => { moderatorRef.current      = moderator;      }, [moderator]);
  useEffect(() => { listenerMemoryRef.current = listenerMemory; }, [listenerMemory]);
  useEffect(() => { nameRef.current           = name;           }, [name]);
  useEffect(() => { volumeRef.current     = volume;                      }, [volume]);
  useEffect(() => { mutedRef.current      = muted;                       }, [muted]);
  useEffect(() => { markPlayedRef.current      = podcastHistory.markPlayed;  }, [podcastHistory.markPlayed]);
  useEffect(() => { markMusicPlayedRef.current = musicHistory.markPlayed;   }, [musicHistory.markPlayed]);

  // Set of track IDs that have been played at least once — used for UI indicators.
  const playedTrackIds = useMemo(
    () => new Set(Object.keys(musicHistory.history)),
    [musicHistory.history],
  );

  // Seed ordered arrays when fresh data arrives from the query.
  // Apply liked-track 2x weighting immediately on seed. If the genre
  // selection changes, React Query returns a new array and we reset.
  useEffect(() => {
    if (tracks.length > 0) {
      const currentId = tracksRef.current[idxRef.current]?.id;
      // Always Fisher-Yates shuffle before weighting so each page load / genre
      // change produces a fresh random order. In Top Charts mode we preserve
      // chart ranking so skip the extra shuffle there.
      const toSeed = isTopCharts ? [...tracks] : fisherYates([...tracks]);
      const weighted = likedTracks.applyWeighting(toSeed, currentId);
      // Bias: unplayed tracks bubble to the front; played tracks sorted by
      // play count ascending so the least-played ones come soonest.
      setOrderedTracks(isTopCharts ? weighted : applyPlayCountBias(weighted, musicHistory.history, currentId));
    }
  }, [tracks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-shuffle once after ALL tracks have loaded (isLoading → false), before
  // the radio starts. Watching orderedTracks.length caused premature shuffles on
  // partial batches and race conditions when the first tracks arrived while the
  // greeting was in-flight. Using !isLoading ensures the full batch is present.
  const autoShuffledRef = useRef(false);
  useEffect(() => {
    if (!isLoading && tracks.length > 0 && !autoShuffledRef.current && !greetedRef.current) {
      autoShuffledRef.current = true;
      console.log('[AutoShuffle] shuffling playlist after full load');
      setOrderedTracks(prev => {
        const shuffled = fisherYates([...prev]);
        tracksRef.current = shuffled;
        return shuffled;
      });
    }
  }, [isLoading, tracks.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-apply weighting whenever the liked set changes (like/unlike action).
  // Preserves the currently playing track at its position.
  useEffect(() => {
    if (orderedTracks.length > 0) {
      const currentId = tracksRef.current[idxRef.current]?.id;
      setOrderedTracks(prev => likedTracks.applyWeighting(
        // De-duplicate first so we don't compound duplicates on every like
        [...new Map(prev.map(t => [t.id, t])).values()],
        currentId,
      ));
    }
  }, [likedTracks.liked]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (episodes.length > 0) {
      // Filter out already-played episodes so the queue always feels fresh.
      // If all episodes have been played (e.g. only one feed), show them all
      // again rather than an empty queue.
      const fresh = episodes.filter(ep => !podcastHistory.hasPlayed(ep.id));
      const pool  = fresh.length > 0 ? fresh : episodes;
      // Episodes with a transcript URL float to the top — best listening experience.
      const sorted = [...pool].sort((a, b) => (b.transcriptUrl ? 1 : 0) - (a.transcriptUrl ? 1 : 0));
      setOrderedEpisodes(sorted);
    }
  }, [episodes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep refs in sync with ordered arrays (so the loop reads the user's order).
  // These are the authoritative refs used by advanceLoop.
  useEffect(() => { tracksRef.current   = orderedTracks;   }, [orderedTracks]);
  useEffect(() => { episodesRef.current = orderedEpisodes; }, [orderedEpisodes]);

  // Fetch a small ambient bridge pool once on mount — separate from the main
  // playlist, used only as background music under podcast transition speech.
  useEffect(() => {
    fetchAmbientBridgePool(5).then(pool => { ambientBridgeRef.current = pool; });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Push listener memory context to the AI moderator whenever memory changes.
  useEffect(() => {
    moderatorRef.current.setMemoryContext(listenerMemory.getMemoryContext());
  }, [listenerMemory.memory]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist queue to localStorage whenever the ordered lists or current index
  // change. This lets us restore the queue instantly on page return without
  // waiting for the API to resolve again.
  useEffect(() => {
    if (orderedTracks.length > 0) {
      saveQueue(orderedTracks, orderedEpisodes, idxRef.current);
    }
  }, [orderedTracks, orderedEpisodes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Also persist the index whenever it changes (idx state mirrors idxRef).
  useEffect(() => {
    if (orderedTracks.length > 0) {
      saveQueue(orderedTracks, orderedEpisodes, idx);
    }
  }, [idx]); // eslint-disable-line react-hooks/exhaustive-deps

  // On mount: sync local idx state from the persistent idxRef so the playlist
  // highlight is correct when returning from Settings while audio plays.
  // Also restore the persisted queue index when the radio hasn't started yet
  // (greetedRef false = first visit or after a hard refresh).
  useEffect(() => {
    if (!greetedRef.current) {
      const { idx: savedIdx } = loadQueue();
      idxRef.current = savedIdx;
      setIdx(savedIdx);
    } else {
      setIdx(idxRef.current);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Wire UI state listeners to the persistent audio elements ─────────────
  // The <audio> elements live in RadioContext (above the router) so they
  // survive navigations. We attach/detach event listeners on each mount so
  // this page's setState callbacks stay fresh. The elements themselves are
  // never paused or destroyed here.
  useEffect(() => {
    const audio = audioRef.current;
    const pod   = podAudioRef.current;
    if (!audio || !pod) return;

    // ── Music element listeners ───────────────────────────────────────────────
    // Unconditionally forward time/duration — no !paused guard.
    // The guard was the bug: during buffering stalls the browser briefly marks
    // the element as paused even while conceptually playing, silently dropping
    // every timeupdate and freezing the bar at 0:00.
    // When both elements fire simultaneously (crossfade), pod wins via the
    // nowPlayingRef tiebreaker only in onMusicTime.
    const onMusicTime  = () => {
      // If pod is the active element, let its listener take precedence
      if (nowPlayingRef.current?.kind === 'podcast') return;
      setCT(audio.currentTime);
    };
    const onMusicDur   = () => {
      if (nowPlayingRef.current?.kind === 'podcast') return;
      setDur(isFinite(audio.duration) ? audio.duration : 0);
    };
    const onMusicMeta  = () => {
      if (nowPlayingRef.current?.kind === 'podcast') return;
      setDur(isFinite(audio.duration) ? audio.duration : 0);
    };
    const onMusicPlay  = () => { console.log('[Music] play');  setPlaying(true);  setBuf(false); };
    const onMusicPause = () => { console.log('[Music] pause'); setPlaying(false); };
    const onMusicWait  = () => { if (nowPlayingRef.current?.kind !== 'podcast') setBuf(true); };
    const onMusicCan   = () => { if (nowPlayingRef.current?.kind !== 'podcast') setBuf(false); };
    const onMusicErr   = () => { if (audio.src) console.error('[Music] error', audio.error?.message); };

    audio.addEventListener('timeupdate',     onMusicTime);
    audio.addEventListener('durationchange', onMusicDur);
    audio.addEventListener('loadedmetadata', onMusicMeta);
    audio.addEventListener('play',           onMusicPlay);
    audio.addEventListener('pause',          onMusicPause);
    audio.addEventListener('waiting',        onMusicWait);
    audio.addEventListener('canplay',        onMusicCan);
    audio.addEventListener('error',          onMusicErr);

    // ── Podcast element listeners ─────────────────────────────────────────────
    // Also unconditional — always forward time/duration from pod.
    // The old nowPlayingRef guard caused durationchange + timeupdate to be
    // dropped when they fired before setNowPlaying('podcast') was called.
    const onPodTime  = () => {
      if (Math.floor(pod.currentTime) % 30 === 0 && Math.floor(pod.currentTime) > 0) {
        console.log(`[Podcast] timeupdate ct=${pod.currentTime.toFixed(1)} dur=${pod.duration}`);
      }
      setCT(pod.currentTime);
      // When the browser streams a podcast, duration may be Infinity or NaN
      // until enough data is buffered. Update it opportunistically here so
      // the seek bar fills in as soon as the browser knows the duration.
      if (isFinite(pod.duration) && pod.duration > 0) setDur(pod.duration);
      // Throttled position save (every 5 s) so we can resume after pause/reload
      const epId = nowPlayingRef.current?.kind === 'podcast' ? nowPlayingRef.current.episode.id : null;
      if (epId && pod.currentTime > 5) {
        const now = Date.now();
        if (now - lastPodSaveRef.current > 5000) {
          savePodcastPosition(epId, pod.currentTime);
          lastPodSaveRef.current = now;
        }
      }
    };
    const onPodDur   = () => { if (isFinite(pod.duration) && pod.duration > 0) setDur(pod.duration); };
    const onPodMeta  = () => { if (isFinite(pod.duration) && pod.duration > 0) setDur(pod.duration); };
    const onPodPlay  = () => { console.log('[Podcast] play'); setPlaying(true);  setBuf(false); };
    const onPodPause = () => { console.log('[Podcast] pause'); setPlaying(false); };
    const onPodWait  = () => setBuf(true);
    const onPodCan   = () => setBuf(false);
    const onPodErr   = () => { if (pod.src) console.error('[Podcast] audio error', pod.error?.message); };

    pod.addEventListener('timeupdate',     onPodTime);
    pod.addEventListener('durationchange', onPodDur);
    pod.addEventListener('loadedmetadata', onPodMeta);
    pod.addEventListener('play',           onPodPlay);
    pod.addEventListener('pause',          onPodPause);
    pod.addEventListener('waiting',        onPodWait);
    pod.addEventListener('canplay',        onPodCan);
    pod.addEventListener('error',          onPodErr);

    // Sync UI state immediately on mount — handles returning from Settings
    // while audio was already playing in RadioContext.
    if (!pod.paused) {
      setPlaying(true);
      setCT(pod.currentTime);
      if (isFinite(pod.duration)) setDur(pod.duration);
    } else if (!audio.paused) {
      setPlaying(true);
      setCT(audio.currentTime);
      if (isFinite(audio.duration)) setDur(audio.duration);
    }

    return () => {
      // Detach listeners only — do NOT pause or clear src.
      audio.removeEventListener('timeupdate',     onMusicTime);
      audio.removeEventListener('durationchange', onMusicDur);
      audio.removeEventListener('loadedmetadata', onMusicMeta);
      audio.removeEventListener('play',           onMusicPlay);
      audio.removeEventListener('pause',          onMusicPause);
      audio.removeEventListener('waiting',        onMusicWait);
      audio.removeEventListener('canplay',        onMusicCan);
      audio.removeEventListener('error',          onMusicErr);

      pod.removeEventListener('timeupdate',     onPodTime);
      pod.removeEventListener('durationchange', onPodDur);
      pod.removeEventListener('loadedmetadata', onPodMeta);
      pod.removeEventListener('play',           onPodPlay);
      pod.removeEventListener('pause',          onPodPause);
      pod.removeEventListener('waiting',        onPodWait);
      pod.removeEventListener('canplay',        onPodCan);
      pod.removeEventListener('error',          onPodErr);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Ducking — ramp audio.volume on isSpeaking changes ────────────────────
  useEffect(() => {
    // The podcast transition sequence owns the volume ramp during its window.
    // Skip this generic duck so we don't cancel or override that fade.
    if (podcastTransitionRef.current) return;

    console.log('[Duck] effect fired — isSpeaking:', moderator.isSpeaking, '| audio.volume:', audioRef.current?.volume ?? 'no audio');
    const audio = audioRef.current;
    if (!audio) return;
    cancelRampRef.current?.();

    if (moderator.isSpeaking) {
      const howl = howlRef.current;
      if (howl) {
        console.log(`[Duck] Howler fade: ${howl.volume().toFixed(2)} → ${DUCK_LEVEL} (instant)`);
        howl.fade(howl.volume() as number, DUCK_LEVEL, 0);
      } else {
        // audio.volume is read-only on iOS Safari (PWA and browser).
        // Wavlake CDN sends no CORS headers so GainNode is not an option either.
        // On iOS we pause the music instead of ducking; on desktop we duck to
        // DUCK_LEVEL so there is still background music under TTS.
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        if (isIOS) {
          console.log('[Duck] iOS — pausing music during TTS (volume read-only, no CORS)');
          if (!audio.paused) audio.pause();
        } else {
          console.log(`[Duck] duckDown() → ${DUCK_LEVEL}`);
          audio.volume = DUCK_LEVEL;
        }
      }
      cancelRampRef.current = null;
    } else {
      const target = mutedRef.current ? 0 : volumeRef.current;
      const howl = howlRef.current;
      if (howl) {
        console.log(`[Duck] Howler fade: ${DUCK_LEVEL} → ${target} over 2000ms`);
        howl.fade(DUCK_LEVEL, target, 2000);
      } else {
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        if (isIOS) {
          // Resume music after TTS — play() is async but this fires after speech
          // so the gesture token is stale; iOS should still allow it because the
          // element was already unlocked in handlePlay.
          console.log('[Duck] iOS — resuming music after TTS');
          audio.play().catch(e => console.warn('[Duck] iOS resume failed:', e));
        } else {
          console.log(`[Duck] fadeBack() → ${target} over 2000ms`);
          cancelRampRef.current = rampVolume(audio, target, 2000);
        }
      }
    }
    return () => cancelRampRef.current?.();
  }, [moderator.isSpeaking]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Volume/mute slider (when not ducked) ─────────────────────────────────
  // Only fires on user volume/mute changes — NOT on isSpeaking changes, so the
  // ducking fade-back ramp started above is not immediately cancelled.
  useEffect(() => {
    const audio = audioRef.current;
    const pod   = podAudioRef.current;
    if (!audio || moderator.isSpeaking) return;
    cancelRampRef.current?.();
    const target = muted ? 0 : volume;
    audio.volume = target;
    // Apply to podcast element too — keeps slider in sync when a podcast is playing
    if (pod) pod.volume = target;
    // nextAudio: only force-mute if the user mutes; otherwise let the crossfade
    // ramp manage it (so we don't cancel a crossfade-in mid-flight).
    if (muted && nextAudioRef.current) {
      cancelNextRampRef.current?.();
      nextAudioRef.current.volume = 0;
    }
  }, [volume, muted]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Core loop — stable, reads everything via refs ─────────────────────────
  // ── Howler.js shadow instance (parallel, not playing yet) ─────────────────
  // Initialises a Howl alongside the existing audioRef system so we can verify
  // Howler loads correctly before migrating playback. Never calls .play().
  const _initHowl = useCallback((url: string) => {
    howlRef.current?.unload();
    howlRef.current = new Howl({
      src: [url],
      html5: true, // required for streaming audio
      volume: 0.9,
      onload:      () => console.log('[Howler] loaded:', url),
      onloaderror: (_id: number, err: unknown) => console.warn('[Howler] load error:', err),
    });
    console.log('[Howler] initialized (not playing)');
  }, []);

  const advanceLoop = useCallback(async () => {
    const audio     = audioRef.current;
    const nextAudio = nextAudioRef.current;
    if (!audio) return;

    console.log('[Loop] advanceLoop() started, idxRef:', idxRef.current);

    while (runningRef.current) {
      // ── Resume a podcast episode that was paused mid-playback ──────────────
      const resumeEp = resumePodcastEpisodeRef.current;
      if (resumeEp) {
        resumePodcastEpisodeRef.current = null;
        const pod = podAudioRef.current;
        if (pod?.getAttribute('src') && runningRef.current) {
          console.log(`[Loop] resuming paused podcast: "${resumeEp.title}"`);
          try { await pod.play(); } catch (e) { console.warn('[Loop] pod resume failed:', e); }

          // Wait for episode to finish or user to pause again
          if (runningRef.current) {
            await new Promise<void>(res => {
              const onEnded       = () => { cleanup(); res(); };
              const onResumePause = () => { if (!runningRef.current) { cleanup(); res(); } };
              function cleanup() {
                pod.removeEventListener('ended',  onEnded);
                pod.removeEventListener('pause',  onResumePause);
              }
              pod.addEventListener('ended', onEnded);
              pod.addEventListener('pause', onResumePause);
            });
          }

          pod.pause();
          if (runningRef.current) {
            // Episode finished naturally after resume
            pod.src = '';
            markPlayedRef.current(resumeEp.id);
            setOrderedEpisodes(prev => prev.filter(e => e.id !== resumeEp.id));
            const nextMusicTrack = tracksRef.current[idxRef.current];
            if (nextMusicTrack) await moderatorRef.current.speakPodcastOutro(resumeEp, nextMusicTrack);
          } else {
            // Paused again — save for next resume
            resumePodcastEpisodeRef.current = resumeEp;
          }
        }
        if (!runningRef.current) break;
        continue;
      }

      const tracks     = tracksRef.current;
      const currentIdx = idxRef.current;
      const t          = tracks[currentIdx];

      if (!tracks.length || !t) {
        console.log('[Loop] no tracks — exiting');
        break;
      }

      console.log(`[Loop] loading track ${currentIdx}: "${t.name}" by ${t.artist}`);

      loopGenRef.current++; // invalidate any listeners from the previous iteration

      const nextIdx   = (currentIdx + 1) % tracks.length;
      const nextTrack = tracks[nextIdx];

      // ── If a crossfade already handed off this track, audio is playing it ──
      // Skip the load/play so we don't interrupt the seamless transition.
      if (crossfadeActiveRef.current) {
        crossfadeActiveRef.current = false;
        console.log('[Loop] crossfade handoff — skipping reload, audio already playing');
        // Sync UI state
        setCT(audio.currentTime);
        setDur(audio.duration || t.duration || 0);
        setIdx(currentIdx);
        nowPlayingRef.current = { kind: 'music', track: t };
        setNowPlaying({ kind: 'music', track: t });
        // Volume guard: promotion sets full volume, but the duck effect may have
        // fired during the async load. Correct immediately rather than waiting
        // for the speech/no-speech branch to ramp up from 0.08.
        if (!mutedRef.current) {
          const expected = volumeRef.current;
          if (audio.volume < expected - 0.05) {
            console.log(`[Crossfade] volume was ${audio.volume.toFixed(2)} — correcting to ${expected.toFixed(2)}`);
            cancelRampRef.current?.();
            audio.volume = expected;
          }
        }
      } else if (resumeMusicRef.current) {
        // ── User resumed after pausing mid-track — src is still loaded ─────
        resumeMusicRef.current = false;
        console.log(`[Loop] music resume — playing from ${audio.currentTime.toFixed(1)}s`);
        // Sync UI state (don't reset setCT — keep current position)
        setIdx(currentIdx);
        nowPlayingRef.current = { kind: 'music', track: t };
        setNowPlaying({ kind: 'music', track: t });
        try {
          await audio.play();
          console.log('[Loop] resume play() resolved');
        } catch (e) {
          console.warn('[Loop] resume play() failed:', e);
        }
      } else {
        // Normal load
        audio.pause();
        audio.src    = t.liveUrl;
        audio.volume = DUCK_LEVEL; // always start ducked; speech/crossfade controls volume
        audio.load();
        _initHowl(t.liveUrl); // shadow Howl — verifies loading, never plays
        setCT(0);
        setDur(t.duration || 0);
        setIdx(currentIdx);

        nowPlayingRef.current = { kind: 'music', track: t };
        setNowPlaying({ kind: 'music', track: t });
        listenerMemoryRef.current.recordSongStart(t);

        // Pre-load the next track into nextAudio at volume 0 so it's buffered.
        // Do this early — before speech — so the browser has time to buffer.
        if (nextAudio && nextTrack && nextTrack.id !== t.id) {
          nextAudio.pause();
          nextAudio.src    = nextTrack.liveUrl;
          nextAudio.volume = 0;
          nextAudio.load();
          console.log(`[Crossfade] pre-loading next: "${nextTrack.name}"`);
        }

        // Wait for the current track to buffer before playing — prevents dead air.
        if (audio.readyState < 3 /* HAVE_FUTURE_DATA */) {
          await new Promise<void>(resolve => {
            audio.addEventListener('canplay', () => resolve(), { once: true });
            audio.addEventListener('error',   () => resolve(), { once: true });
            setTimeout(resolve, 5000); // fallback — don't block forever
          });
        }

        const howl = howlRef.current;
        if (howl) {
          howl.volume(DUCK_LEVEL);
          howl.play();
          console.log(`[Howler] playing: ${t.name}`);
        } else {
          try {
            await audio.play();
            console.log('[Loop] audio.play() resolved at duck level');
          } catch (e) {
            console.error('[Loop] audio.play() failed — skipping to next track:', e);
            // Skip to next track rather than freezing the loop.
            // (Autoplay-blocked errors will be caught by the user pressing play again.)
            idxRef.current = (currentIdx + 1) % tracks.length;
            await sleep(200);
            continue;
          }
        }
      }

      if (!runningRef.current) break;

      // 2. Speak over the playing music; when isSpeaking flips false the
      //    ducking useEffect automatically fades volume back to target.
      if (skipRef.current) {
        // User just skipped — say a brief hardcoded reaction then carry on.
        skipRef.current = false;
        console.log('[Loop] skip — speakUserControlReaction');
        await moderatorRef.current.speakUserControlReaction();
      } else if (!greetedRef.current) {
        greetedRef.current = true;
        console.log('[Loop] greeting + track intro over music');
        await moderatorRef.current.speakGreeting(nameRef.current);
        await sleep(400);
        await moderatorRef.current.speakTrackIntro(t, t.isTopChart, listenerMemoryRef.current.memory.likedSongs.includes(t.id));
      } else if (silentCountRef.current >= silentBudgetRef.current && recentTracksRef.current.length > 0) {
        // Time for a DJ break — review recent tracks and intro this one
        const played = recentTracksRef.current;
        recentTracksRef.current = [];
        console.log('[Loop] moderation — speakReviewAndIntro over music');
        await moderatorRef.current.speakReviewAndIntro(played, t, t.isTopChart, listenerMemoryRef.current.memory.likedSongs.includes(t.id));
        // Reset the silent counter AFTER speaking so the podcast check below
        // still has access to the accumulated count before we cleared it.
        silentCountRef.current  = 0;
        silentBudgetRef.current = randInt(1, 2);
      } else {
        // No speech this track — fade up immediately
        console.log('[Loop] no speech — fading up now');
        cancelRampRef.current?.();
        const target = mutedRef.current ? 0 : volumeRef.current;
        const howlNoSpeech = howlRef.current;
        if (howlNoSpeech) {
          console.log(`[Howler] fade: ${DUCK_LEVEL} → ${target}`);
          howlNoSpeech.fade(DUCK_LEVEL, target, 1000);
        } else {
          cancelRampRef.current = rampVolume(audio, target, 1000);
        }
      }

      if (!runningRef.current) { console.log('[Loop] runningRef false — exiting'); break; }

      // 3. Wait until CROSSFADE_SECS before the end, then crossfade to next track.
      //    Falls back to waiting for 'ended' if duration is unknown or very short.
      //    Each iteration gets a unique generation number to cancel stale listeners.
      const myGen = ++loopGenRef.current;

      const endedNaturally = await new Promise<boolean>(resolve => {
        let crossfadeStarted = false;

        // ── Crossfade logic ───────────────────────────────────────────────────
        const startCrossfade = () => {
          if (crossfadeStarted || !runningRef.current) return;
          if (!nextAudio || !nextTrack) return;
          // Don't crossfade during moderator speech (music is ducked) —
          // let the track end naturally and advance cleanly after.
          if (moderatorRef.current.isSpeaking || moderatorRef.current.isGenerating) return;

          crossfadeStarted = true;
          console.log(`[Crossfade] starting ${CROSSFADE_SECS}s crossfade → "${nextTrack.name}"`);

          const fadeDurationMs = CROSSFADE_SECS * 1000;
          const targetVol = mutedRef.current ? 0 : volumeRef.current;

          // Fade out current
          cancelRampRef.current?.();
          cancelRampRef.current = rampVolume(audio, 0, fadeDurationMs, () => {
            // Current fully faded — stop it cleanly
            audio.pause();
            // nextAudio is now the active track; resolve so the loop advances
            if (loopGenRef.current === myGen) {
              cleanup();
              console.log('[Crossfade] complete — advancing loop');
              resolve(true);
            }
          });

          // Fade in next (already at volume 0 from pre-load).
          // Wait for canplay so there's no dead air if buffering is still in progress.
          nextAudio.volume = 0;
          cancelNextRampRef.current?.();
          const startNextPlayback = () => {
            nextAudio.play().then(() => {
              cancelNextRampRef.current = rampVolume(nextAudio, targetVol, fadeDurationMs);
            }).catch(e => {
              console.warn('[Crossfade] nextAudio.play() failed:', e);
              crossfadeStarted = false;
            });
          };
          if (nextAudio.readyState >= 3 /* HAVE_FUTURE_DATA */) {
            startNextPlayback();
          } else {
            console.log('[Crossfade] waiting for canplay on nextAudio…');
            nextAudio.addEventListener('canplay', startNextPlayback, { once: true });
          }
        };

        const onTimeUpdate = () => {
          if (loopGenRef.current !== myGen) return;
          if (crossfadeStarted) return;
          // Never start a crossfade while the moderator is speaking or generating —
          // music is ducked and fading in the next track would be inaudible/jarring.
          // onTimeUpdate fires every ~250ms so when speech ends the crossfade will
          // start on the very next tick (provided we're still in the window).
          if (moderatorRef.current.isSpeaking || moderatorRef.current.isGenerating) return;
          const dur = audio.duration;
          const ct  = audio.currentTime;
          // Only crossfade if: duration is known, track is longer than 2× crossfade,
          // and we're within the crossfade window
          if (
            isFinite(dur) &&
            dur > CROSSFADE_SECS * 2 &&
            ct >= dur - CROSSFADE_SECS
          ) {
            startCrossfade();
          }
        };

        const onEnded = () => {
          if (loopGenRef.current !== myGen) return;
          cleanup();
          console.log(`[Loop] ended naturally (no crossfade, gen ${myGen})`);
          resolve(true);
        };

        const onPause = () => {
          if (loopGenRef.current !== myGen) return;
          if (!runningRef.current) {
            cleanup();
            console.log(`[Loop] paused by user (gen ${myGen})`);
            resolve(false);
          }
          // else: browser fires pause just before ended on natural end — wait for ended
        };

        function cleanup() {
          audio.removeEventListener('timeupdate', onTimeUpdate);
          audio.removeEventListener('ended',      onEnded);
          audio.removeEventListener('pause',      onPause);
        }

        // If the track already ended during the speech phase (e.g. seeked to
        // near-end by jumpToEpisode while TTS was still playing), `ended` fired
        // before these listeners were registered and will never fire again.
        // Resolve immediately so the loop doesn't hang.
        if (audio.ended) {
          console.log(`[Loop] track already ended during speech — advancing (gen ${myGen})`);
          resolve(true);
          return;
        }
        if (!runningRef.current) { resolve(false); return; }

        audio.addEventListener('timeupdate', onTimeUpdate);
        audio.addEventListener('ended',      onEnded);
        audio.addEventListener('pause',      onPause);
      });

      if (!runningRef.current) { console.log('[Loop] runningRef false — exiting'); break; }

      // ── After crossfade: nextAudio faded in, audio faded out ─────────────────
      // Promote nextAudio → audio by moving its src/position into the primary
      // element. Set crossfadeActiveRef so the loop top skips the reload.
      const crossfadeHappened = endedNaturally && nextAudio != null && !nextAudio.paused && nextTrack != null;
      if (crossfadeHappened) {
        console.log('[Crossfade] promoting nextAudio → audio');

        // Load audio in the background while nextAudio KEEPS PLAYING — this
        // eliminates the gap that occurred when we paused nextAudio first.
        const targetVol = mutedRef.current ? 0 : volumeRef.current;
        audio.src    = nextTrack!.liveUrl;
        audio.volume = targetVol;
        audio.load();
        await new Promise<void>(res => {
          const onCanPlay = () => { audio.removeEventListener('canplay', onCanPlay); res(); };
          audio.addEventListener('canplay', onCanPlay);
          setTimeout(res, 500); // fallback — don't block forever
        });

        // Snap to the live position of nextAudio (it has been playing throughout).
        // Do NOT gate on isFinite(audio.duration) — duration may not be known yet
        // when the canplay/500ms fallback fires, which would leave audio playing
        // from the start instead of the handoff position.
        const handoffPos = isFinite(nextAudio!.currentTime) ? nextAudio!.currentTime : 0;
        if (handoffPos > 0) {
          audio.currentTime = handoffPos;
        }

        // Switch: pause nextAudio only after audio is ready — minimal gap.
        // Volume is already at targetVol; no ramp needed.
        nextAudio!.pause();
        audio.volume = targetVol; // guard: re-assert in case duck effect fired during load
        console.log(`[Crossfade] immediate fade-up to ${targetVol.toFixed(2)} on handoff`);
        if (audio.paused) {
          try { await audio.play(); } catch { /* ignore */ }
        }

        // Advance silent counter for the track that just ended (t)
        recentTracksRef.current = [...recentTracksRef.current, t].slice(-2);
        silentCountRef.current++;
        markMusicPlayedRef.current(t.id);

        // Signal the loop top that audio is already loaded & playing
        crossfadeActiveRef.current = true;
        idxRef.current = nextIdx;
        // Fall through to podcast check with nextMusicIdx = nextIdx + 1 below
      }

      if (endedNaturally) {
        // If crossfade happened, counters & idxRef were already updated above.
        // Only update them here for the normal (non-crossfade) case.
        if (!crossfadeHappened) {
          recentTracksRef.current = [...recentTracksRef.current, t].slice(-2);
          silentCountRef.current++;
          markMusicPlayedRef.current(t.id);
          idxRef.current = (currentIdx + 1) % tracks.length;
        }

        const nextMusicIdx = idxRef.current;
        console.log(`[Loop] index advanced → ${nextMusicIdx}`);
        console.log(`[Loop] silentCount=${silentCountRef.current} / budget=${silentBudgetRef.current}, episodes=${episodesRef.current.length}`);

        // ── Podcast slot every 2–3 music tracks ──────────────────────────────
        const eps = episodesRef.current;
        if (silentCountRef.current >= silentBudgetRef.current && eps.length > 0) {
          // Reset counters BEFORE entering podcast block so the next music
          // cycle starts fresh regardless of what happens inside.
          silentCountRef.current  = 0;
          silentBudgetRef.current = randInt(2, 3);

          const epIdx   = podcastIdxRef.current % eps.length;
          const episode = eps[epIdx];
          podcastIdxRef.current++;

          // ── Guard: skip episodes with no playable audio URL ───────────────
          // An empty audioUrl causes MEDIA_ELEMENT_ERROR and freezes the loop.
          // Mark it played (removes from queue) and fall through to the next
          // music track immediately — the radio never stops for a bad URL.
          if (!episode.audioUrl || !episode.audioUrl.trim()) {
            console.warn(`[Loop] skipping episode with empty audioUrl: "${episode.title}" from ${episode.feedTitle}`);
            markPlayedRef.current(episode.id);
            setOrderedEpisodes(prev => prev.filter(e => e.id !== episode.id));
            // Don't break — fall through so music continues immediately.
          } else {

          const nextMusicTrack = tracksRef.current[nextMusicIdx];

          console.log(`[Loop] podcast slot — "${episode.title}" from ${episode.feedTitle}`);

          // ── Transition: ambient bridge → moderator → fade → jingle → podcast
          podcastTransitionRef.current = true;

          // 1. Stop current music; find an ambient bridge track.
          audio.pause();
          // Prefer the dedicated bridge pool (always ambient, never in playlist).
          // Fall back to ambient tracks in the main queue if the pool is empty.
          const bridgePool = ambientBridgeRef.current.length > 0
            ? ambientBridgeRef.current
            : tracksRef.current.filter(t => t.genreId === 'ambient');
          const bridgeTrack = bridgePool.length > 0
            ? bridgePool[Math.floor(Math.random() * bridgePool.length)]
            : null;

          let bridgeAudio: HTMLAudioElement | null = null;
          if (bridgeTrack) {
            bridgeAudio          = new Audio(bridgeTrack.liveUrl);
            bridgeAudio.preload  = 'auto';
            bridgeAudio.volume   = 0;
            bridgeAudio.load();
            // Wait up to 3 s for enough data, then start regardless
            await new Promise<void>(resolve => {
              bridgeAudio!.addEventListener('canplay', () => resolve(), { once: true });
              bridgeAudio!.addEventListener('error',   () => resolve(), { once: true });
              setTimeout(resolve, 3000);
            });
            bridgeAudio.volume = 0.3;
            bridgeAudio.play().catch(() => {});
            console.log(`[Bridge] using ambient track: ${bridgeTrack.name} by ${bridgeTrack.artist}`);
          } else {
            console.log('[Loop] podcast bridge — no ambient tracks available, skipping');
          }

          if (!runningRef.current) {
            bridgeAudio?.pause();
            podcastTransitionRef.current = false;
            break;
          }

          // 2. Moderator speaks over ambient bridge (or silence if none available).
          // Check if the listener has been here before (> 60 s heard).
          const epRecord = listenerMemoryRef.current.memory.episodeHistory
            .find(e => e.episodeId === episode.id);
          const resumeCtx: ResumeContext | undefined =
            epRecord && epRecord.lastPosition > 60
              ? { lastPosition: epRecord.lastPosition, topics: epRecord.topics }
              : undefined;
          console.log(
            `[Loop] podcast transition — isResuming=${!!resumeCtx}`,
            resumeCtx ? `lastPosition=${Math.round(resumeCtx.lastPosition)}s topics=[${resumeCtx.topics.join(', ')}]` : '',
          );
          await moderatorRef.current.speakPodcastTransition(
            episode.title, episode.feedTitle, episode.description, episode.author, resumeCtx,
          );

          if (!runningRef.current) {
            bridgeAudio?.pause();
            podcastTransitionRef.current = false;
            break;
          }

          // 3. Fade bridge to 0 (await) — jingle must play into silence.
          if (bridgeAudio) {
            await new Promise<void>(res => { rampVolume(bridgeAudio!, 0, 3000, res); });
            bridgeAudio.pause();
            console.log('[Loop] podcast bridge faded out');
          }

          // 4. Jingle plays after full silence — THEN podcast starts.
          await playJingle('/podcast-intro.mp3');

          if (!runningRef.current) {
            podcastTransitionRef.current = false;
            break;
          }

          podcastTransitionRef.current = false;

          if (!runningRef.current) break;

          // ── Load podcast onto the dedicated CORS-enabled audio element ────
          const pod = podAudioRef.current;
          if (!pod) {
            console.warn('[Loop] podAudioRef not ready — skipping podcast');
          } else {
            loopGenRef.current++;

            // Pause music (now at vol 0) before handing audio to podcast
            audio.pause();

            // Always resolve the final CDN URL via the server-side proxy before
            // loading. Podcast hosts (fountain.fm, anchor.fm) issue 302 redirects
            // to CloudFront URLs that lack CORS headers — iOS Safari blocks these
            // on <audio> elements. The resolver follows the chain server-side and
            // returns only the direct CDN URL; zero audio bytes are transferred.
            console.log(`[Podcast] resolving audio URL via proxy: ${episode.audioUrl}`);
            let audioSrc = episode.audioUrl;
            try {
              const resolverUrl = `/.netlify/functions/podcast-proxy?action=audioresolver&url=${encodeURIComponent(episode.audioUrl)}`;
              const resolveRes = await fetch(resolverUrl, { signal: AbortSignal.timeout(10_000) });
              if (resolveRes.ok) {
                const finalUrl = (await resolveRes.text()).trim();
                if (finalUrl) {
                  console.log(`[Podcast] resolved URL: ${finalUrl}`);
                  audioSrc = finalUrl;
                }
              }
            } catch (resolveErr) {
              console.warn('[Podcast] URL resolution failed — falling back to direct URL:', resolveErr);
            }

            pod.src    = audioSrc;
            pod.volume = mutedRef.current ? 0 : volumeRef.current;
            pod.load();

            if (pod.readyState < 3 /* HAVE_FUTURE_DATA */) {
              await new Promise<void>(resolve => {
                pod.addEventListener('canplay', () => resolve(), { once: true });
                pod.addEventListener('error',   () => resolve(), { once: true });
                setTimeout(resolve, 8000); // slow connection fallback
              });
            }

            // Seek to saved position if this episode was partially played before.
            // The canplay wait above means loadedmetadata has already fired —
            // pod.duration is known and we can seek directly without a listener.
            // If for some reason duration is still unknown (error/timeout path),
            // fall back to a loadedmetadata listener.
            const savedPos = loadPodcastPosition(episode.id);
            if (savedPos > 5) {
              console.log(`[Loop] resuming from saved position ${savedPos.toFixed(0)}s`);
              const doSeek = () => {
                if (isFinite(pod.duration) && savedPos < pod.duration - 10) {
                  pod.currentTime = savedPos;
                  console.log(`[Loop] seeked to ${savedPos.toFixed(0)}s`);
                }
              };
              if (pod.readyState >= 1) { // HAVE_METADATA — duration is known
                doSeek();
              } else {
                pod.addEventListener('loadedmetadata', doSeek, { once: true });
              }
            }

            setCT(savedPos > 5 ? savedPos : 0);
            setDur(episode.duration || 0);

            // Update Now Playing to show podcast info
            nowPlayingRef.current = { kind: 'podcast', episode };
            setNowPlaying({ kind: 'podcast', episode });

            let podStarted = false;
            try {
              await pod.play();
              podStarted = true;
              console.log('[Loop] podcast playing via dedicated element');
            } catch (e) {
              console.error('[Loop] podcast play failed — resetting state:', e);
              // Reset everything so the user can press Play to retry.
              // Without this, runningRef stays true but playing is false — the
              // play button handler short-circuits on "already running" and
              // the UI appears permanently stuck in PAUSED.
              runningRef.current = false;
              resumePodcastEpisodeRef.current = null;
              nowPlayingRef.current = null;
              setNowPlaying(null);
              setPlaying(false);
            }

            // Pod failed to start — runningRef was already set false in the catch.
            if (!podStarted) break;

            // ── Run episode through segmenter ─────────────────────────────
            if (podStarted && runningRef.current) {
              // Snapshot local refs for use inside segmenter callbacks
              const localMod      = moderatorRef;
              const localTracks   = tracksRef;
              const localIdx      = idxRef;
              const localVolume   = volumeRef;
              const localMuted    = mutedRef;

              await segmenter.runEpisode(
                pod,
                episode.title,
                episode.feedTitle,
                episode.chapters,
                /* callbacks ↓ */ {
                  isRunning: () => runningRef.current,

                  speakCommentary: async (script) => {
                    await playJingle('/studio-return.mp3');
                    await localMod.current.speakPodcastSegmentCommentary(script);
                  },

                  playMusicBreak: async () => {
                    // Play 1–3 random Wavlake tracks as a music break
                    const breakCount = randInt(1, 3);
                    const allTracks  = localTracks.current;
                    if (!allTracks.length) return;

                    for (let b = 0; b < breakCount; b++) {
                      if (!runningRef.current) break;

                      // Pick a random track (different from current podcast position)
                      const breakIdx   = Math.floor(Math.random() * allTracks.length);
                      const breakTrack = allTracks[breakIdx];

                      console.log(`[Loop] music break ${b + 1}/${breakCount}: "${breakTrack.name}"`);

                      // Update Now Playing to music
                      nowPlayingRef.current = { kind: 'music', track: breakTrack };
                      setNowPlaying({ kind: 'music', track: breakTrack });

                      // Intro the first track of the break
                      if (b === 0) {
                        await localMod.current.speakTrackIntro(breakTrack);
                      }

                      if (!runningRef.current) break;

                      // Load & play on the music element (no CORS, as always)
                      audio.src    = breakTrack.liveUrl;
                      audio.volume = DUCK_LEVEL;
                      audio.load();

                      loopGenRef.current++;
                      const breakGen = loopGenRef.current;

                      try {
                        await audio.play();
                      } catch (e) {
                        console.error('[Loop] break music play failed:', e);
                        break;
                      }

                      // Fade up after intro
                      cancelRampRef.current?.();
                      const target = localMuted.current ? 0 : localVolume.current;
                      cancelRampRef.current = rampVolume(audio, target, 1000);

                      // Wait for break track to end or loop to be stopped
                      await new Promise<void>(res => {
                        const onEnded = () => { if (loopGenRef.current !== breakGen) return; cleanup(); res(); };
                        const onPause = () => { if (loopGenRef.current !== breakGen) return; if (!runningRef.current) { cleanup(); res(); } };
                        function cleanup() {
                          audio.removeEventListener('ended', onEnded);
                          audio.removeEventListener('pause', onPause);
                        }
                        audio.addEventListener('ended', onEnded);
                        audio.addEventListener('pause', onPause);
                      });

                      audio.pause();
                    }

                    // Restore Now Playing to podcast
                    nowPlayingRef.current = { kind: 'podcast', episode };
                    setNowPlaying({ kind: 'podcast', episode });

                    // Update the playlist cursor to reflect where we are
                    idxRef.current = localIdx.current;
                  },

                  speakReturn: async (podcastTitle, partNumber) => {
                    await localMod.current.speakPodcastReturn(podcastTitle, partNumber);
                  },
                },
                episode.description,
                episode.transcriptUrl,
              );
            }

            // ── Episode finished or user paused ───────────────────────────
            pod.pause();
            if (runningRef.current) {
              // Finished naturally — clean up and mark played
              pod.removeAttribute('src');
              markPlayedRef.current(episode.id);
              setOrderedEpisodes(prev => prev.filter(e => e.id !== episode.id));

              if (nextMusicTrack) {
                // ── Post-podcast transition: radio-style, no dead air ──────
                // Same pattern as the intro bridge: music plays at 0.3 while
                // the moderator speaks, then fades up to full afterwards.

                // 1. Studio-return jingle (podcast → music handoff cue)
                podcastTransitionRef.current = true;
                await playJingle('/studio-return.mp3');

                if (!runningRef.current) { podcastTransitionRef.current = false; break; }

                // 2. Start next song at low volume BEFORE moderator speaks
                console.log('[Loop] post-podcast — starting music before commentary');
                audio.src    = nextMusicTrack.liveUrl;
                audio.volume = 0.3;
                audio.load();
                if (audio.readyState < 3) {
                  await new Promise<void>(resolve => {
                    audio.addEventListener('canplay', () => resolve(), { once: true });
                    audio.addEventListener('error',   () => resolve(), { once: true });
                    setTimeout(resolve, 5000);
                  });
                }
                let postPodMusicStarted = false;
                try { await audio.play(); postPodMusicStarted = true; } catch (e) {
                  console.warn('[Loop] post-podcast music play failed:', e);
                  runningRef.current = false;
                  podcastTransitionRef.current = false;
                  setPlaying(false);
                }
                if (!postPodMusicStarted) break;

                nowPlayingRef.current = { kind: 'music', track: nextMusicTrack };
                setNowPlaying({ kind: 'music', track: nextMusicTrack });
                setCT(0);
                setDur(nextMusicTrack.duration || 0);
                setIdx(idxRef.current);
                listenerMemoryRef.current.recordSongStart(nextMusicTrack);

                if (!runningRef.current) {
                  podcastTransitionRef.current = false;
                  crossfadeActiveRef.current   = true;
                  break;
                }

                // 3. Moderator speaks OVER the music at 0.3
                //    podcastTransitionRef prevents the duck effect from interfering
                await moderatorRef.current.speakPodcastOutro(episode, nextMusicTrack);

                if (!runningRef.current) {
                  podcastTransitionRef.current = false;
                  crossfadeActiveRef.current   = true;
                  break;
                }

                // 4. Fade music up to full after commentary
                cancelRampRef.current?.();
                const outroTarget = mutedRef.current ? 0 : volumeRef.current;
                cancelRampRef.current = rampVolume(audio, outroTarget, 1000);
                podcastTransitionRef.current = false;

                // Signal the loop top to skip reloading — audio is playing and ramping up
                crossfadeActiveRef.current = true;
              }
            } else {
              // User paused mid-episode — preserve src and queue entry for resume
              resumePodcastEpisodeRef.current = episode;
            }
          }

          // Clear the recent-tracks buffer so the review after a podcast
          // doesn't reference stale pre-podcast tracks.
          recentTracksRef.current = [];

          } // end: else (episode has a valid audioUrl)
        }
        // loop continues — next iteration picks up idxRef.current
      }
    }

    console.log('[Loop] advanceLoop() exited');
  }, []); // stable — all state via refs

  // ── Start (first play press) ──────────────────────────────────────────────
  const startRadio = useCallback(async () => {
    if (!tracksRef.current.length) { console.warn('[Start] no tracks yet'); return; }
    if (runningRef.current) { console.log('[Start] already running'); return; }

    console.log('[Start] startRadio()');
    runningRef.current = true;
    idxRef.current     = 0;
    resumePodcastEpisodeRef.current = null; // never carry over a stale resume from a previous session
    await advanceLoop();
  }, [advanceLoop]);

  // ── Public controls ───────────────────────────────────────────────────────
  const handlePlay = useCallback(() => {
    console.log('[PlayPause] handlePlay — runningRef:', runningRef.current, '| greeted:', greetedRef.current, '| resumePodcast:', resumePodcastEpisodeRef.current?.title ?? 'none');
    // If the loop is already running (e.g. we navigated away and came back),
    // there's nothing to do — audio is already playing in the background.
    if (runningRef.current) return;

    // ── Pre-unlock the podcast element within the gesture ─────────────────────
    // pod.play() is called 10+ seconds after the gesture (bridge fade + TTS +
    // jingle). iOS revokes the gesture token after ~1 second of async work.
    // Calling muted play()+pause() here "stamps" the element as gesture-unlocked
    // so the real pod.play() later is allowed even without a fresh gesture.
    const pod = podAudioRef.current;
    if (pod) {
      pod.muted = true;
      pod.play().catch(() => {});
      pod.pause();
      pod.muted = false;
      console.log('[iOS] podcast element pre-unlocked');
    }
    if (!greetedRef.current) {
      startRadio();
    } else {
      runningRef.current = true;
      if (resumePodcastEpisodeRef.current) {
        // Resuming mid-podcast — advanceLoop will handle pod.play(); don't touch audioRef.
        console.log('[PlayPause] resuming podcast:', resumePodcastEpisodeRef.current.title);
        advanceLoop();
      } else if (audioRef.current?.src && audioRef.current.paused) {
        // Resuming music — src is still loaded, signal the loop to skip reload.
        console.log('[PlayPause] resuming music from', audioRef.current.currentTime.toFixed(1));
        resumeMusicRef.current = true;
        advanceLoop();
      } else {
        // No src loaded yet (edge case) — restart the loop so it loads the next track.
        advanceLoop();
      }
    }
  }, [startRadio, advanceLoop]);

  const handlePause = useCallback(() => {
    console.log('[PlayPause] handlePause — nowPlaying:', nowPlayingRef.current?.kind ?? 'none', '| resumePodcast before:', resumePodcastEpisodeRef.current?.title ?? 'none');
    runningRef.current = false;
    moderatorRef.current.stop();

    // Set the resume ref synchronously here rather than relying on the async
    // loop to set it (race: the loop sets it only after awaited promises resolve,
    // but handlePlay can be called before that completes).
    // Guard: only set if not already populated, so the loop's own assignment
    // (which may run later) is a harmless no-op.
    if (nowPlayingRef.current?.kind === 'podcast' && !resumePodcastEpisodeRef.current) {
      resumePodcastEpisodeRef.current = nowPlayingRef.current.episode;
      console.log('[PlayPause] handlePause — set resumePodcastEpisodeRef:', nowPlayingRef.current.episode.title);
    }

    audioRef.current?.pause();
    podAudioRef.current?.pause(); // also pause podcast if one is playing
  }, []);

  const jumpTo = useCallback((newIdx: number, userSkipped = false) => {
    console.log('[JumpTo]', newIdx, userSkipped ? '(user skip)' : '');
    const wasRunning = runningRef.current;

    // Record skip on the currently playing music track before stopping.
    if (userSkipped && wasRunning && nowPlayingRef.current?.kind === 'music') {
      listenerMemoryRef.current.recordSongSkip(nowPlayingRef.current.track.id);
    }

    // Stop the loop and interrupt any in-progress speech immediately.
    // moderator.stop() aborts the ElevenLabs fetch/playback so the awaited
    // speakXxx() promises resolve right away rather than after the full clip.
    runningRef.current = false;
    moderatorRef.current.stop();

    // Stop both audio elements so no stale 'pause' event lingers on the wrong
    // element (e.g. podcast playing while we skip music).
    audioRef.current?.pause();
    podAudioRef.current?.pause();
    // removeAttribute rather than .src = '' so that getAttribute('src') reliably
    // returns null/'' — the IDL property .src would otherwise return the document
    // base URL for an empty content attribute, breaking guards that check .src.
    if (podAudioRef.current) podAudioRef.current.removeAttribute('src');
    // Discard any pending podcast resume — skipping means we abandon the episode.
    resumePodcastEpisodeRef.current = null;

    idxRef.current = newIdx;
    setIdx(newIdx);

    // Flag the next loop iteration to emit a skip-aware intro instead of the
    // normal greeting/review sequence. Only set when the user explicitly skips.
    if (userSkipped && wasRunning) {
      skipRef.current = true;
    }

    if (wasRunning) {
      // Brief delay so the 'pause' event from audio.pause() fires and clears
      // any lingering inner-promise listeners before we restart the loop.
      setTimeout(() => {
        runningRef.current = true;
        advanceLoop();
      }, 150);
    }
  }, [advanceLoop]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePrev   = useCallback(() => jumpTo((idxRef.current - 1 + tracksRef.current.length) % tracksRef.current.length, true), [jumpTo]);
  const handleNext   = useCallback(() => jumpTo((idxRef.current + 1) % tracksRef.current.length, true), [jumpTo]);
  const handleSelect = useCallback((i: number) => jumpTo(i, false), [jumpTo]);

  const handleDislike = useCallback((track: WavlakeTrack) => {
    listenerMemory.recordSongDislike(track.id);
    setOrderedTracks(prev => prev.filter(t => t.id !== track.id));
    handleNext();
  }, [handleNext, listenerMemory]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePodSkip = useCallback((deltaSecs: number) => {
    const pod = podAudioRef.current;
    if (!pod || nowPlayingRef.current?.kind !== 'podcast') return;
    const clamped = Math.max(0, Math.min(pod.duration || 0, pod.currentTime + deltaSecs));
    pod.currentTime = clamped;
    savePodcastPosition(nowPlayingRef.current.episode.id, clamped);
  }, []);

  // ── Jump directly to a podcast episode ────────────────────────────────────
  // Moves the episode to the front of the queue, forces the podcast slot to
  // fire on the very next track end, and seeks the current music track to
  // near its end so the episode starts within ~1 second.
  const jumpToEpisode = useCallback((episode: PodcastEpisode) => {
    // Move episode to front of queue
    setOrderedEpisodes(prev => {
      const next = [episode, ...prev.filter(e => e.id !== episode.id)];
      episodesRef.current = next;
      return next;
    });
    podcastIdxRef.current  = 0;
    silentCountRef.current = silentBudgetRef.current; // trigger podcast slot immediately
    recentTracksRef.current = [];                      // suppress DJ-break speech

    // Restart loop at current track with user-skip flag
    // (speakUserControlReaction fires, then quick track end, then podcast)
    jumpTo(idxRef.current, true);

    // Seek to near-end of current track so the loop advances in ~300ms
    setTimeout(() => {
      const audio = audioRef.current;
      if (!audio || !runningRef.current) return;
      const seekToEnd = () => {
        if (isFinite(audio.duration) && audio.duration > 1) {
          audio.currentTime = Math.max(0, audio.duration - 0.3);
        }
      };
      if (isFinite(audio.duration) && audio.duration > 1) {
        seekToEnd();
      } else {
        audio.addEventListener('loadedmetadata', seekToEnd, { once: true });
      }
    }, 500);
  }, [jumpTo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Drag-and-drop handlers ─────────────────────────────────────────────────
  const handleDragEnd = useCallback((result: DropResult) => {
    const { source, destination } = result;
    if (!destination) return; // dropped outside a list
    if (source.index === destination.index && source.droppableId === destination.droppableId) return;

    const droppableId = source.droppableId;

    if (droppableId === 'playlist') {
      setOrderedTracks(prev => {
        const next = [...prev];
        // source/destination indices are relative to the visible window; offset by current position
        const actualSrc = idxRef.current + source.index;
        const actualDst = idxRef.current + destination.index;
        const [moved] = next.splice(actualSrc, 1);
        next.splice(actualDst, 0, moved);

        // Keep idxRef pointing at the same track after reorder
        const currentTrack = tracksRef.current[idxRef.current];
        if (currentTrack) {
          const newIdx = next.findIndex(t => t.id === currentTrack.id);
          if (newIdx !== -1) {
            idxRef.current = newIdx;
            setIdx(newIdx);
          }
        }

        tracksRef.current = next;
        return next;
      });
    } else if (droppableId === 'podcast-queue') {
      setOrderedEpisodes(prev => {
        const next = [...prev];
        const [moved] = next.splice(source.index, 1);
        next.splice(destination.index, 0, moved);
        episodesRef.current = next;

        // Reset podcast index so the loop picks up from position 0
        podcastIdxRef.current = 0;
        return next;
      });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep durationRef in sync so seekToX always sees the current duration
  // without creating a new function reference every time duration changes.
  useEffect(() => { durationRef.current = duration; }, [duration]);

  // Seek bar ref — used to attach a native non-passive touchmove listener so
  // e.preventDefault() actually prevents scroll on iOS Safari. React's synthetic
  // onTouchMove is passive by default and cannot call preventDefault().
  const seekBarRef = useRef<HTMLDivElement>(null);

  // Stable callback — reads duration via ref so the native touch listeners
  // registered below never go stale even as duration changes.
  const seekToX = useCallback((clientX: number, rect: DOMRect) => {
    const pod   = podAudioRef.current;
    const audio = audioRef.current;
    const el    = (pod && !pod.paused) ? pod : audio;
    const dur   = durationRef.current;
    if (!el || !dur) return;
    const r = (clientX - rect.left) / rect.width;
    el.currentTime = Math.max(0, Math.min(1, r)) * dur;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Attach native (non-passive) touch listeners to the seek bar so touchmove
  // can call preventDefault() to prevent page scroll while dragging on iOS.
  useEffect(() => {
    const el = seekBarRef.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const touch = e.touches[0] ?? e.changedTouches[0];
      if (touch) seekToX(touch.clientX, el.getBoundingClientRect());
    };
    const onTouchStartOrEnd = (e: TouchEvent) => {
      const touch = e.touches[0] ?? e.changedTouches[0];
      if (touch) seekToX(touch.clientX, el.getBoundingClientRect());
    };
    el.addEventListener('touchmove',  onTouchMove,       { passive: false });
    el.addEventListener('touchstart', onTouchStartOrEnd, { passive: true  });
    el.addEventListener('touchend',   onTouchStartOrEnd, { passive: true  });
    return () => {
      el.removeEventListener('touchmove',  onTouchMove);
      el.removeEventListener('touchstart', onTouchStartOrEnd);
      el.removeEventListener('touchend',   onTouchStartOrEnd);
    };
  }, [seekToX]);

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    seekToX(e.clientX, e.currentTarget.getBoundingClientRect());
  };

  // ── Derived UI ────────────────────────────────────────────────────────────
  // Use orderedTracks so the displayed track matches what the loop is playing
  const track = (orderedTracks.length > 0 ? orderedTracks : tracks)[idx];
  // Sliding window: current track is always at position 0, show up to 10 ahead
  const windowTracks = orderedTracks.slice(idx, idx + 10);
  // For streaming podcasts duration may be 0/Infinity even while playing.
  // Fall through to the RSS episode.duration as a best-effort estimate.
  const effectiveDuration =
    duration > 0 && isFinite(duration)
      ? duration
      : nowPlaying?.kind === 'podcast'
        ? (nowPlaying.episode.duration || 0)
        : (track?.duration || 0);
  const pct = effectiveDuration > 0 ? Math.min(100, (currentTime / effectiveDuration) * 100) : 0;
  const isModerating = moderator.isSpeaking || moderator.isGenerating;
  const statusLabel  = moderator.isGenerating ? 'WRITING' : moderator.isSpeaking ? 'ON AIR' : buffering ? 'BUFFERING' : playing ? 'LIVE' : 'PAUSED';
  const statusColor  = isModerating ? 'bg-amber-400' : playing ? 'bg-red-500 animate-pulse' : 'bg-white/30';

  return (
    <div className="min-h-screen gradient-bg text-white relative overflow-x-hidden">
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 left-1/3 w-96 h-96 bg-purple-900/20 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/3 w-80 h-80 bg-violet-900/20 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 max-w-2xl mx-auto px-4 py-8 space-y-6">

        {/* Header */}
        <header className="flex items-center justify-between fade-in-up">
          <div>
            <button onClick={() => navigate('/settings')} className="text-xs tracking-[0.25em] text-purple-400 uppercase font-semibold hover:text-purple-300 transition-colors flex items-center gap-1.5">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M15 18l-6-6 6-6"/></svg>
              PR Personal Radio
            </button>
            <h2 className="text-2xl font-bold mt-1">Hey, <span className="text-purple-300">{firstName}</span> 👋</h2>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/settings')} className="w-9 h-9 rounded-full flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/10 transition-all" aria-label="Settings">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
            </button>
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-full px-4 py-2">
              <div className={`w-2 h-2 rounded-full ${statusColor}`} />
              <span className="text-xs font-semibold tracking-wider text-white/60">{statusLabel}</span>
            </div>
          </div>
        </header>

        {/* Moderator banner */}
        {isModerating && (
          <div className="fade-in-up glass-card rounded-2xl px-5 py-4 flex items-center gap-4 border border-amber-500/20">
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center flex-shrink-0 animate-pulse">
              <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zm-1 16.93V21h2v-3.07A7.002 7.002 0 0 0 19 11h-2a5 5 0 0 1-10 0H5a7.002 7.002 0 0 0 6 6.93z"/></svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-0.5">
                {moderator.isGenerating ? 'AI Host is writing…' : 'AI Host is speaking'}
              </p>
              <div className="flex items-end gap-0.5 h-4">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div key={i} className={`w-1 rounded-full bg-amber-400 wave-bar ${moderator.isGenerating ? 'paused' : ''}`} style={{ height: '4px' }} />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Player card */}
        <div className="fade-in-up-delay-2 glass-card rounded-3xl p-6">
          <div className="flex items-center gap-3 sm:gap-5 mb-6">
            <div className="relative flex-shrink-0">
              {nowPlaying?.kind === 'podcast' ? (
                /* Podcast: static icon disc — no spin */
                <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full overflow-hidden border-4 border-amber-700/60 shadow-2xl bg-amber-900/30 flex items-center justify-center text-4xl select-none">
                  🎙️
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-6 h-6 rounded-full bg-black/40 border-2 border-amber-400/20" />
                  </div>
                </div>
              ) : (
                /* Music: spinning vinyl */
                <div className={`w-20 h-20 sm:w-24 sm:h-24 rounded-full overflow-hidden border-4 border-gray-700 shadow-2xl bg-gray-800 ${(playing && !isModerating) ? 'vinyl-spin' : 'vinyl-spin paused'}`}>
                  {track?.artworkUrl && <img src={track.artworkUrl} alt={track.name} className="w-full h-full object-cover" onError={e => (e.currentTarget.style.display = 'none')} />}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-6 h-6 rounded-full bg-black/60 border-2 border-white/20" />
                  </div>
                </div>
              )}
              {(playing && !isModerating) && (
                <div className={`absolute inset-0 rounded-full blur-xl animate-pulse pointer-events-none ${
                  nowPlaying?.kind === 'podcast'
                    ? 'bg-amber-500/15'
                    : nowPlaying?.kind === 'music' && nowPlaying.track.isTopChart
                      ? 'bg-amber-500/15'
                      : 'bg-purple-600/15'
                }`} />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-xs font-semibold uppercase tracking-widest ${nowPlaying?.kind === 'podcast' ? 'text-amber-400' : nowPlaying?.kind === 'music' && nowPlaying.track.isTopChart ? 'text-amber-400' : 'text-purple-400'}`}>
                  {nowPlaying?.kind === 'podcast'
                    ? 'Now Playing · Podcast'
                    : nowPlaying?.kind === 'music' && nowPlaying.track.isTopChart
                      ? 'Now Playing · Top Charts'
                      : 'Now Playing'}
                </span>
                {nowPlaying?.kind === 'music' && nowPlaying.track && (
                  <>
                    <button
                      onClick={() => { likedTracks.toggle(nowPlaying.track); listenerMemory.recordSongLike(nowPlaying.track); }}
                      aria-label={likedTracks.isLiked(nowPlaying.track.id) ? 'Unlike track' : 'Like track'}
                      className="transition-colors"
                    >
                      <svg className={`w-3.5 h-3.5 transition-colors ${likedTracks.isLiked(nowPlaying.track.id) ? 'text-pink-400 fill-pink-400' : 'text-white/25 fill-none stroke-white/25'}`} viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDislike(nowPlaying.track)}
                      aria-label="Never play this track again"
                      title="Never play this track again"
                      className="text-white/20 hover:text-red-400 transition-colors"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                    <a href={`https://wavlake.com/track/${nowPlaying.track.id}`} target="_blank" rel="noopener noreferrer" className="text-white/20 hover:text-purple-400 transition-colors">
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </a>
                  </>
                )}
              </div>
              {isLoading ? (
                <div className="space-y-2"><Skeleton className="h-5 w-36 bg-white/10"/><Skeleton className="h-3.5 w-24 bg-white/10"/></div>
              ) : isError ? (
                <p className="text-red-400 text-sm">Couldn't load tracks</p>
              ) : nowPlaying?.kind === 'podcast' ? (
                <>
                  <h3 className="text-base sm:text-xl font-bold truncate">{nowPlaying.episode.title}</h3>
                  <p className="text-white/60 text-sm truncate">{nowPlaying.episode.feedTitle}</p>
                  <span className="inline-block mt-2 text-xs text-amber-400/80 bg-amber-900/20 border border-amber-700/30 rounded-full px-3 py-0.5">🎙️ Podcast</span>
                </>
              ) : nowPlaying?.kind === 'music' ? (
                <>
                  <h3 className="text-base sm:text-xl font-bold truncate">{nowPlaying.track.name}</h3>
                  <p className="text-white/60 text-sm truncate">{nowPlaying.track.artist}</p>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {nowPlaying.track.isTopChart && (
                      <span className="text-xs text-amber-300 bg-amber-900/30 border border-amber-500/40 rounded-full px-3 py-0.5">⚡ Top Charts</span>
                    )}
                    {nowPlaying.track.albumTitle && !nowPlaying.track.isTopChart && (
                      <span className="text-xs text-purple-300/70 bg-purple-900/30 border border-purple-700/30 rounded-full px-3 py-0.5">{nowPlaying.track.albumTitle}</span>
                    )}
                  </div>
                </>
              ) : track ? (
                /* Fallback before loop starts */
                <>
                  <h3 className="text-base sm:text-xl font-bold truncate">{track.name}</h3>
                  <p className="text-white/60 text-sm truncate">{track.artist}</p>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {track.isTopChart && (
                      <span className="text-xs text-amber-300 bg-amber-900/30 border border-amber-500/40 rounded-full px-3 py-0.5">⚡ Top Charts</span>
                    )}
                    {track.albumTitle && !track.isTopChart && (
                      <span className="text-xs text-purple-300/70 bg-purple-900/30 border border-purple-700/30 rounded-full px-3 py-0.5">{track.albumTitle}</span>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          </div>

          {/* Waveform */}
          <div className="flex items-end justify-center gap-1 h-8 mb-5">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className={`w-1.5 rounded-full bg-gradient-to-t from-violet-600 to-purple-400 wave-bar ${(!playing || buffering || isModerating) ? 'paused' : ''}`} style={{ height: '4px' }} />
            ))}
          </div>

          {/* Seek */}
          <div className="mb-5">
            <div
              ref={seekBarRef}
              className="w-full h-1.5 bg-white/10 rounded-full cursor-pointer group touch-none py-2 -my-2"
              onClick={handleSeek}
            >
              <div className="h-1.5 rounded-full progress-bar-inner relative pointer-events-none" style={{ width: `${pct}%` }}>
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white shadow-lg opacity-0 group-hover:opacity-100 sm:transition-opacity pointer-events-none" />
              </div>
            </div>
            <div className="flex justify-between mt-1.5 text-xs text-white/30">
              <span>{fmt(currentTime)}</span>
              <span>{effectiveDuration > 0 ? fmt(effectiveDuration) : '—'}</span>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-1">
              <button onClick={() => setMuted(m => !m)} className="flex-shrink-0 text-white/40 hover:text-white/80 transition-colors" aria-label={muted ? 'Unmute' : 'Mute'}>
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  {muted
                    ? <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                    : <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                  }
                </svg>
              </button>
              {/* Volume slider: hidden on mobile to save space */}
              <input type="range" min={0} max={1} step={0.02} value={muted ? 0 : volume}
                onChange={e => { setVol(+e.target.value); setMuted(false); }}
                className="hidden sm:block w-20 h-1" aria-label="Volume" />
            </div>
            <div className="flex items-center gap-1.5 sm:gap-3">
              <button onClick={handlePrev} disabled={isLoading} className="w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-all disabled:opacity-30" aria-label="Previous">
                <svg className="w-4 h-4 sm:w-5 sm:h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
              </button>
              <button
                onClick={() => handlePodSkip(-30)}
                disabled={nowPlaying?.kind !== 'podcast'}
                className="w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-all disabled:opacity-20 disabled:pointer-events-none"
                aria-label="Skip back 30 seconds"
              >
                <svg className="w-4 h-4 sm:w-5 sm:h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
                  <text x="12" y="14.5" textAnchor="middle" fontSize="5.5" fontWeight="bold" fill="currentColor">30</text>
                </svg>
              </button>
              <button onClick={playing ? handlePause : handlePlay} disabled={isLoading || (orderedTracks.length === 0 && tracks.length === 0)}
                className="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-gradient-to-br from-violet-600 to-purple-700 flex items-center justify-center glow-purple hover:scale-105 active:scale-95 transition-all shadow-lg disabled:opacity-40"
                aria-label={playing ? 'Pause' : 'Play'}>
                {buffering && !isModerating
                  ? <svg className="w-5 h-5 text-white animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                  : playing
                    ? <svg className="w-5 h-5 sm:w-6 sm:h-6 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                    : <svg className="w-5 h-5 sm:w-6 sm:h-6 text-white ml-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                }
              </button>
              <button
                onClick={() => handlePodSkip(30)}
                disabled={nowPlaying?.kind !== 'podcast'}
                className="w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-all disabled:opacity-20 disabled:pointer-events-none"
                aria-label="Skip forward 30 seconds"
              >
                <svg className="w-4 h-4 sm:w-5 sm:h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/>
                  <text x="12" y="14.5" textAnchor="middle" fontSize="5.5" fontWeight="bold" fill="currentColor">30</text>
                </svg>
              </button>
              <button onClick={handleNext} disabled={isLoading} className="w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-all disabled:opacity-30" aria-label="Next">
                <svg className="w-4 h-4 sm:w-5 sm:h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
              </button>
            </div>
            <div className="flex-1 flex justify-end">
              <a href="https://wavlake.com" target="_blank" rel="noopener noreferrer" className="hidden sm:inline text-white/20 hover:text-purple-400 transition-colors text-xs">⚡ Wavlake</a>
            </div>
          </div>
        </div>

        {/* Genre selector — directly below player, above podcasts */}
        <div className="fade-in-up-delay-3 space-y-3">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-semibold text-white/60 uppercase tracking-widest">Genres</h3>
            {(!isAllSelected && !isTopCharts) && (
              <button
                onClick={selectAll}
                className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
              >
                All
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {/* ⚡ Top Charts — exclusive mode, always shown first */}
            <button
              onClick={() => toggle(TOP_CHARTS_ID)}
              aria-pressed={isTopCharts}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold tracking-wide border transition-all duration-150 select-none
                ${isTopCharts
                  ? 'bg-amber-500/25 border-amber-400/70 text-amber-200 shadow-sm shadow-amber-900/40'
                  : 'bg-white/5 border-white/10 text-white/40 hover:border-amber-500/40 hover:text-amber-300/70'
                }`}
            >
              ⚡ Top Charts
            </button>

            {/* Standard genre pills */}
            {GENRES.map(genre => {
              const active = !isTopCharts && selectedIds.includes(genre.id);
              return (
                <button
                  key={genre.id}
                  onClick={() => toggle(genre.id)}
                  aria-pressed={active}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold tracking-wide border transition-all duration-150 select-none
                    ${active
                      ? 'bg-purple-600/30 border-purple-500/60 text-purple-200 shadow-sm shadow-purple-900/40'
                      : 'bg-white/5 border-white/10 text-white/40 hover:border-white/25 hover:text-white/60'
                    } ${isTopCharts ? 'opacity-40' : ''}`}
                >
                  {genre.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Drag-and-drop context wraps both sortable lists */}
        <DragDropContext onDragEnd={handleDragEnd}>

          {/* Coming Up — podcast queue (draggable) */}
          {(orderedEpisodes.length > 0 || storedFeeds.length > 0) && (
            <div className="fade-in-up-delay-3 space-y-3">
              <div className="flex items-center justify-between px-1">
                <h3 className="text-sm font-semibold text-white/60 uppercase tracking-widest">Coming Up · Podcasts</h3>
                <div className="flex items-center gap-3">
                  {orderedEpisodes.some(ep => ep.transcriptUrl) && (
                    <span className="text-xs text-emerald-400/60">✓ Best listening experience</span>
                  )}
                  {orderedEpisodes.length > 0 && (
                    <span className="text-xs text-amber-400/60">drag to reorder</span>
                  )}
                  <button
                    onClick={() => { setStoredFeeds(getStoredFeeds()); refetchEpisodes(); }}
                    disabled={episodesFetching}
                    className="flex items-center gap-1 text-xs text-amber-400/70 hover:text-amber-300 transition-colors disabled:opacity-40"
                    aria-label="Refresh podcast queue"
                  >
                    <svg className={`w-3 h-3 ${episodesFetching ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2m15.357 2H15"/>
                    </svg>
                    {episodesFetching ? 'Loading…' : 'Refresh'}
                  </button>
                </div>
              </div>
              <Droppable droppableId="podcast-queue">
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className={`space-y-2 rounded-2xl transition-colors ${snapshot.isDraggingOver ? 'bg-amber-900/10' : ''}`}
                  >
                     {orderedEpisodes.length === 0 && storedFeeds.length > 0 && (
                       <div className="glass-card rounded-2xl px-5 py-6 text-center">
                         <p className="text-sm text-white/40">
                           {episodesFetching ? 'Loading episodes…' : 'No episodes loaded yet.'}
                         </p>
                         {!episodesFetching && (
                           <button
                             onClick={() => refetchEpisodes()}
                             className="mt-2 text-xs text-amber-400 hover:text-amber-300 transition-colors underline underline-offset-2"
                           >
                             Tap to refresh
                           </button>
                         )}
                       </div>
                     )}
                     {orderedEpisodes.slice(0, 5).map((ep, i) => (
                       <Draggable key={ep.id} draggableId={`ep-${ep.id}`} index={i}>
                         {(drag, dragSnapshot) => (
                           <PortalAware
                             provided={drag}
                             snapshot={dragSnapshot}
                             className={`glass-card rounded-2xl p-4 flex items-start gap-4 transition-all
                               ${dragSnapshot.isDragging ? 'shadow-2xl shadow-amber-900/30 ring-1 ring-amber-500/30 opacity-95' : ''}
                             `}
                           >
                             {/* Drag handle */}
                             <div
                               {...drag.dragHandleProps}
                               className="flex-shrink-0 flex items-center justify-center w-5 self-center cursor-grab active:cursor-grabbing text-white/20 hover:text-white/50 transition-colors"
                               aria-label="Drag to reorder"
                             >
                               <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                 <path d="M8 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM14 6a2 2 0 1 1 4 0 2 2 0 0 1-4 0zM14 12a2 2 0 1 1 4 0 2 2 0 0 1-4 0zM14 18a2 2 0 1 1 4 0 2 2 0 0 1-4 0z"/>
                               </svg>
                             </div>
                             <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0 text-lg">🎙️</div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-0.5">
                                  <span className="text-xs font-bold uppercase tracking-wider text-amber-400">Podcast</span>
                                  {ep.duration > 0 && (() => {
                                    const saved = loadPodcastPosition(ep.id);
                                    const remaining = saved > 5 ? ep.duration - saved : ep.duration;
                                    return remaining > 0 ? (
                                      <>
                                        <span className="text-xs text-white/25">·</span>
                                        <span className="text-xs text-white/40">
                                          {saved > 5 ? `${fmt(remaining)} left` : fmt(ep.duration)}
                                        </span>
                                      </>
                                    ) : null;
                                  })()}
                                  {ep.transcriptUrl && (
                                    <span
                                      title="Best listening experience — full transcript available"
                                      className="text-emerald-400/80 text-xs leading-none"
                                    >✓</span>
                                  )}
                                  {i === 0 && <span className="text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-full px-2 py-0.5">Up next</span>}
                                </div>
                                <p className="text-sm font-semibold text-white truncate">{ep.title}</p>
                                <p className="text-xs text-white/40 mt-0.5">{ep.feedTitle}</p>
                              </div>
                              {/* Play episode now */}
                              <button
                                onClick={e => { e.stopPropagation(); jumpToEpisode(ep); }}
                                aria-label="Play episode now"
                                title="Play now"
                                className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-amber-400/60 hover:text-amber-300 hover:bg-amber-900/30 transition-colors"
                              >
                                <svg className="w-3.5 h-3.5 ml-0.5" viewBox="0 0 24 24" fill="currentColor">
                                  <path d="M8 5v14l11-7z"/>
                                </svg>
                              </button>
                              {/* Remove episode from queue */}
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  setOrderedEpisodes(prev => prev.filter(e => e.id !== ep.id));
                                }}
                                aria-label="Remove episode from queue"
                                className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-white/25 hover:text-red-400 hover:bg-red-900/20 transition-colors"
                              >
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                              </button>
                            </PortalAware>
                         )}
                       </Draggable>
                     ))}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </div>
          )}

          {/* Playlist (draggable) */}
          <div className="fade-in-up-delay-3 space-y-3">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-sm font-semibold text-white/60 uppercase tracking-widest">
                {isTopCharts ? '⚡ Top Charts' : 'Playlist'}
              </h3>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setOrderedTracks(prev => {
                    const shuffled = fisherYates([...prev]);
                    tracksRef.current = shuffled;
                    return shuffled;
                  })}
                  disabled={isLoading || orderedTracks.length === 0}
                  aria-label="Shuffle playlist"
                  title="Shuffle"
                  className="text-white/30 hover:text-purple-400 transition-colors disabled:opacity-20"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
                    <polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
                  </svg>
                </button>
                <span className={`text-xs ${isTopCharts ? 'text-amber-400' : 'text-purple-400'}`}>
                  {isLoading ? '…' : isTopCharts ? `Top ${orderedTracks.length || tracks.length}` : `${orderedTracks.length || tracks.length} tracks`}
                </span>
              </div>
            </div>
            <div className="glass-card rounded-2xl">
              {isLoading ? (
                <div className="divide-y divide-white/5">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                      <Skeleton className="w-8 h-8 rounded-lg bg-white/10"/>
                      <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-3/5 bg-white/10"/><Skeleton className="h-3 w-2/5 bg-white/10"/></div>
                      <Skeleton className="h-3 w-8 bg-white/10"/>
                    </div>
                  ))}
                </div>
              ) : isError ? (
                <div className="px-4 py-8 text-center"><p className="text-white/40 text-sm">Couldn't load playlist from Wavlake.</p></div>
              ) : (
                <Droppable droppableId="playlist">
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={`divide-y divide-white/5 transition-colors ${snapshot.isDraggingOver ? 'bg-purple-900/10' : ''}`}
                    >
                       {windowTracks.map((t, i) => (
                         <Draggable key={t.id} draggableId={`track-${t.id}`} index={i}>
                           {(drag, dragSnapshot) => {
                             const isCurrent = i === 0;
                             return (
                             <PortalAware
                               provided={drag}
                               snapshot={dragSnapshot}
                               className={`flex items-center gap-3 px-4 py-3.5 transition-all
                                 ${isCurrent ? 'bg-purple-900/20' : 'hover:bg-white/5'}
                                 ${dragSnapshot.isDragging ? 'shadow-xl shadow-purple-900/40 bg-[rgba(30,20,60,0.95)] ring-1 ring-purple-500/40 rounded-xl opacity-95' : ''}
                               `}
                             >
                               {/* Drag handle */}
                               <div
                                 {...drag.dragHandleProps}
                                 className="flex-shrink-0 w-5 flex items-center justify-center cursor-grab active:cursor-grabbing text-white/15 hover:text-white/40 transition-colors"
                                 aria-label="Drag to reorder"
                               >
                                 <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                                   <path d="M8 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM14 6a2 2 0 1 1 4 0 2 2 0 0 1-4 0zM14 12a2 2 0 1 1 4 0 2 2 0 0 1-4 0zM14 18a2 2 0 1 1 4 0 2 2 0 0 1-4 0z"/>
                                 </svg>
                               </div>

                               {/* Track number / playing indicator */}
                               <button
                                 onClick={() => handleSelect(idx + i)}
                                 className="w-6 flex items-center justify-center flex-shrink-0"
                                 aria-label={isCurrent ? 'Currently playing' : `Play ${t.name}`}
                               >
                                 {isCurrent
                                   ? <div className="flex items-end gap-0.5 h-5">{[1,2,3].map(b => <div key={b} className={`w-1 rounded-full bg-purple-400 wave-bar ${(!playing || isModerating) ? 'paused' : ''}`} style={{ height: '4px' }} />)}</div>
                                   : <span className="text-white/30 text-xs hover:text-white/60">{idx + i + 1}</span>
                                 }
                               </button>

                               {/* Artwork */}
                               <button onClick={() => handleSelect(idx + i)} className="w-9 h-9 rounded-lg overflow-hidden flex-shrink-0 bg-white/5">
                                 <img src={t.artworkUrl} alt={t.name} className="w-full h-full object-cover" loading="lazy" onError={e => (e.currentTarget.style.display = 'none')} />
                               </button>

                               {/* Info */}
                               <button onClick={() => handleSelect(idx + i)} className="flex-1 min-w-0 text-left">
                                 <p className={`text-sm font-medium truncate flex items-center gap-1.5 ${isCurrent ? 'text-purple-300' : 'text-white/80'}`}>
                                   {t.isTopChart && (
                                     <span className="flex-shrink-0 text-amber-400 text-xs" title="Top Charts — Lightning-boosted hit">⚡</span>
                                   )}
                                   <span className="truncate">{t.name}</span>
                                 </p>
                                 <p className="text-xs text-white/40 truncate">{t.artist}</p>
                               </button>

                                {/* Like button */}
                                <button
                                  onClick={e => { e.stopPropagation(); likedTracks.toggle(t); listenerMemory.recordSongLike(t); }}
                                  aria-label={likedTracks.isLiked(t.id) ? 'Unlike track' : 'Like track'}
                                  className="flex-shrink-0 p-1 rounded-full transition-colors hover:bg-white/10"
                                >
                                  <svg
                                    className={`w-3.5 h-3.5 transition-colors ${likedTracks.isLiked(t.id) ? 'text-pink-400 fill-pink-400' : 'text-white/20 fill-none stroke-white/20'}`}
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                  >
                                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                                  </svg>
                                </button>
                                <span className="text-xs text-white/30 flex-shrink-0">{fmt(t.duration)}</span>
                                {/* Delete track from playlist */}
                                <button
                                  onClick={e => {
                                    e.stopPropagation();
                                    setOrderedTracks(prev => {
                                      const targetIdx = prev.findIndex(x => x.id === t.id);
                                      const next = prev.filter(x => x.id !== t.id);
                                      if (targetIdx !== -1 && targetIdx < idxRef.current) {
                                        idxRef.current = Math.max(0, idxRef.current - 1);
                                        setIdx(idxRef.current);
                                      }
                                      tracksRef.current = next;
                                      return next;
                                    });
                                  }}
                                  aria-label="Remove from playlist"
                                  className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-white/20 hover:text-red-400 hover:bg-red-900/20 transition-colors"
                                >
                                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                                  </svg>
                                </button>
                              </PortalAware>
                             );
                            }}
                          </Draggable>
                        ))}
                       {provided.placeholder}
                     </div>
                   )}
                 </Droppable>
              )}
            </div>
          </div>

        </DragDropContext>

        {/* ── Episode Management — browse all episodes per feed ── */}
        {storedFeeds.length > 0 && (
          <div className="fade-in-up-delay-3 space-y-3">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-sm font-semibold text-white/60 uppercase tracking-widest">Episode Browser</h3>
              <span className="text-xs text-white/30">tap a feed to browse</span>
            </div>
            <div className="space-y-2">
              {storedFeeds.map(feed => (
                <FeedEpisodesPanel
                  key={feed.url}
                  feed={feed}
                  isExpanded={expandedFeed === feed.url}
                  onToggle={() => setExpandedFeed(prev => prev === feed.url ? null : feed.url)}
                  queuedIds={new Set(orderedEpisodes.map(e => e.id))}
                  onAdd={ep => setOrderedEpisodes(prev => prev.some(e => e.id === ep.id) ? prev : [...prev, ep])}
                  onRemove={id => setOrderedEpisodes(prev => prev.filter(e => e.id !== id))}
                  fmt={fmt}
                />
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="text-center pt-2 pb-10">
          <p className="text-white/20 text-xs">
            Music by <a href="https://wavlake.com" target="_blank" rel="noopener noreferrer" className="hover:text-purple-400 transition-colors">Wavlake ⚡</a>
            {' · '}
            <a href="https://shakespeare.diy" target="_blank" rel="noopener noreferrer" className="hover:text-purple-400 transition-colors">Vibed with Shakespeare</a>
          </p>
        </div>
      </div>
    </div>
  );
}

// ── FeedEpisodesPanel ─────────────────────────────────────────────────────────
// Expandable panel for a single podcast feed: shows all available episodes
// with add/remove controls relative to the current queue.

function FeedEpisodesPanel({
  feed,
  isExpanded,
  onToggle,
  queuedIds,
  onAdd,
  onRemove,
  fmt,
}: {
  feed: PodcastFeed;
  isExpanded: boolean;
  onToggle: () => void;
  queuedIds: Set<string>;
  onAdd: (ep: PodcastEpisode) => void;
  onRemove: (id: string) => void;
  fmt: (s: number) => string;
}) {
  const { data: episodes = [], isFetching, isError } = useSingleFeedEpisodes(feed.url, isExpanded);

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      {/* Feed header / toggle */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-white/5 transition-colors text-left"
        aria-expanded={isExpanded}
      >
        <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0 text-base">🎙️</div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white/80 truncate">{feed.title}</p>
          <p className="text-xs text-white/35 truncate">{feed.url}</p>
        </div>
        <svg
          className={`w-4 h-4 text-white/30 flex-shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
        >
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>

      {/* Episodes list */}
      {isExpanded && (
        <div className="border-t border-white/5">
          {isFetching ? (
            <div className="px-4 py-5 text-center">
              <p className="text-sm text-white/30">Loading episodes…</p>
            </div>
          ) : isError ? (
            <div className="px-4 py-5 text-center">
              <p className="text-sm text-red-400/70">Couldn't load episodes. Check your relay or try again later.</p>
            </div>
          ) : episodes.length === 0 ? (
            <div className="px-4 py-5 text-center">
              <p className="text-sm text-white/30">No episodes found.</p>
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {episodes.map(ep => {
                const inQueue = queuedIds.has(ep.id);
                return (
                  <div key={ep.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white/80 truncate">{ep.title}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {ep.duration > 0 && (
                          <span className="text-xs text-white/35">{fmt(ep.duration)}</span>
                        )}
                        {ep.pubDate && (
                          <span className="text-xs text-white/25">
                            {new Date(ep.pubDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        )}
                      </div>
                    </div>
                    {inQueue ? (
                      <button
                        onClick={() => onRemove(ep.id)}
                        aria-label="Remove from queue"
                        className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-red-900/20 hover:text-red-400 hover:border-red-500/30 transition-all"
                      >
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                        In queue
                      </button>
                    ) : (
                      <button
                        onClick={() => onAdd(ep)}
                        aria-label="Add to queue"
                        className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/5 text-white/40 border border-white/10 hover:bg-amber-500/20 hover:text-amber-300 hover:border-amber-500/30 transition-all"
                      >
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                        Add
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
