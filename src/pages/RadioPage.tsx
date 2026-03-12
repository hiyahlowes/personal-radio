import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
} from '@hello-pangea/dnd';
import { useWavlakeTracks, type WavlakeTrack, GENRES } from '@/hooks/useWavlakeTracks';
import { usePodcastEpisodes, getStoredFeeds, type PodcastEpisode } from '@/hooks/usePodcastFeeds';
import { useRadioModerator } from '@/hooks/useRadioModerator';
import { usePodcastSegmenter } from '@/hooks/usePodcastSegmenter';
import { useGenreSelection } from '@/hooks/useGenreSelection';
import { useRadioContext } from '@/contexts/RadioContext';
import { Skeleton } from '@/components/ui/skeleton';
import { getStoredName } from '@/pages/SetupPage';

// ─── RadioItem union ─────────────────────────────────────────────────────────
type RadioItem =
  | { kind: 'music';   track:   WavlakeTrack    }
  | { kind: 'podcast'; episode: PodcastEpisode  };

// ─── Ducking via audio.volume + setInterval ───────────────────────────────────
// Note: Web Audio API MediaElementAudioSourceNode requires CORS headers on the
// media URL. Wavlake's CDN does not send them, so we use audio.volume directly.
const DUCK_LEVEL  = 0.08;
const TICK_MS     = 40;   // ~25 steps/s — smooth enough

function rampVolume(
  audio: HTMLAudioElement,
  target: number,
  durationMs: number,
  onDone?: () => void,
): () => void {
  const start  = audio.volume;
  const steps  = Math.max(1, Math.round(durationMs / TICK_MS));
  const delta  = (target - start) / steps;
  let   count  = 0;
  const id     = setInterval(() => {
    count++;
    audio.volume = count >= steps
      ? target
      : Math.max(0, Math.min(1, start + delta * count));
    if (count >= steps) { clearInterval(id); onDone?.(); }
  }, TICK_MS);
  console.log(`[Duck] rampVolume ${start.toFixed(2)} → ${target.toFixed(2)} over ${durationMs}ms`);
  return () => clearInterval(id);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
function fmt(s: number) {
  if (!isFinite(s) || s < 0) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ─── Component ────────────────────────────────────────────────────────────────
export function RadioPage() {
  const [params]  = useSearchParams();
  const navigate  = useNavigate();
  // Prefer name from URL param (keeps existing behaviour); fall back to localStorage
  const name      = params.get('name') || getStoredName() || 'Listener';
  const firstName = name.split(' ')[0];

  const { selectedIds, toggle, selectAll, isAllSelected } = useGenreSelection();
  const { data: tracks = [], isLoading, isError } = useWavlakeTracks(selectedIds);
  const { data: episodes = [] } = usePodcastEpisodes(getStoredFeeds());
  const moderator = useRadioModerator();

  // ── UI state ──────────────────────────────────────────────────────────────
  const [idx, setIdx]         = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuf]   = useState(false);
  const [currentTime, setCT]  = useState(0);
  const [duration, setDur]    = useState(0);
  const [volume, setVol]      = useState(0.9);
  const [muted, setMuted]     = useState(false);

  // ── Draggable / reorderable local copies of playlist & queue ──────────────
  const [orderedTracks, setOrderedTracks] = useState<WavlakeTrack[]>([]);
  const [orderedEpisodes, setOrderedEpisodes] = useState<PodcastEpisode[]>([]);

  // ── Stable refs ───────────────────────────────────────────────────────────
  const [nowPlaying, setNowPlaying] = useState<RadioItem | null>(null);
  const nowPlayingRef = useRef<RadioItem | null>(null);

  const segmenter = usePodcastSegmenter();
  const radioCtx  = useRadioContext();

  // Audio elements and core loop refs come from RadioContext so they survive
  // route changes (e.g. navigating to Settings and back).
  const audioRef    = radioCtx.audioRef;
  const podAudioRef = radioCtx.podAudioRef;
  const runningRef  = radioCtx.runningRef;
  const greetedRef  = radioCtx.greetedRef;
  const idxRef      = radioCtx.idxRef;
  const loopGenRef  = radioCtx.loopGenRef;

  const cancelRampRef    = useRef<(() => void) | null>(null);
  const tracksRef        = useRef<WavlakeTrack[]>([]);
  const silentCountRef   = useRef(0);
  const silentBudgetRef  = useRef(randInt(2, 3)); // 2-3 music tracks before podcast
  const recentTracksRef  = useRef<WavlakeTrack[]>([]);
  const episodesRef      = useRef<PodcastEpisode[]>([]);
  const podcastIdxRef    = useRef(0); // cycles through episodes
  const moderatorRef     = useRef(moderator);
  const nameRef          = useRef(name);
  const volumeRef        = useRef(0.9);
  const mutedRef         = useRef(false);

  // Sync refs to latest state/props
  useEffect(() => { tracksRef.current    = tracks;    }, [tracks]);
  useEffect(() => { episodesRef.current  = episodes;  }, [episodes]);
  useEffect(() => { moderatorRef.current = moderator; }, [moderator]);
  useEffect(() => { nameRef.current      = name;      }, [name]);
  useEffect(() => { volumeRef.current    = volume;    }, [volume]);
  useEffect(() => { mutedRef.current     = muted;     }, [muted]);

  // Seed ordered arrays when fresh data arrives from the query
  useEffect(() => {
    if (tracks.length > 0) setOrderedTracks(tracks);
  }, [tracks]);
  useEffect(() => {
    if (episodes.length > 0) setOrderedEpisodes(episodes);
  }, [episodes]);

  // Keep refs in sync with ordered arrays (so the loop reads the user's order)
  useEffect(() => { tracksRef.current   = orderedTracks;   }, [orderedTracks]);
  useEffect(() => { episodesRef.current = orderedEpisodes; }, [orderedEpisodes]);

  // ── Wire UI state listeners to the persistent audio elements ─────────────
  // The <audio> elements live in RadioContext (above the router) so they
  // survive navigations. We attach/detach event listeners on each mount so
  // this page's setState callbacks stay fresh. The elements themselves are
  // never paused or destroyed here.
  useEffect(() => {
    const audio = audioRef.current;
    const pod   = podAudioRef.current;
    if (!audio || !pod) return;

    const onMusicTime  = () => setCT(audio.currentTime);
    const onMusicDur   = () => setDur(audio.duration || 0);
    const onMusicPlay  = () => { console.log('[Music] play');  setPlaying(true);  setBuf(false); };
    const onMusicPause = () => { console.log('[Music] pause'); setPlaying(false); };
    const onMusicWait  = () => setBuf(true);
    const onMusicCan   = () => setBuf(false);
    const onMusicErr   = () => { if (audio.src) console.error('[Music] error', audio.error?.message); };

    audio.addEventListener('timeupdate',     onMusicTime);
    audio.addEventListener('durationchange', onMusicDur);
    audio.addEventListener('play',           onMusicPlay);
    audio.addEventListener('pause',          onMusicPause);
    audio.addEventListener('waiting',        onMusicWait);
    audio.addEventListener('canplay',        onMusicCan);
    audio.addEventListener('error',          onMusicErr);

    const onPodTime  = () => { if (nowPlayingRef.current?.kind === 'podcast') setCT(pod.currentTime); };
    const onPodDur   = () => { if (nowPlayingRef.current?.kind === 'podcast') setDur(pod.duration || 0); };
    const onPodPlay  = () => { if (nowPlayingRef.current?.kind === 'podcast') { setPlaying(true); setBuf(false); } };
    const onPodPause = () => { if (nowPlayingRef.current?.kind === 'podcast') setPlaying(false); };
    const onPodWait  = () => { if (nowPlayingRef.current?.kind === 'podcast') setBuf(true); };
    const onPodCan   = () => { if (nowPlayingRef.current?.kind === 'podcast') setBuf(false); };
    const onPodErr   = () => { if (pod.src) console.error('[Podcast] audio error', pod.error?.message); };

    pod.addEventListener('timeupdate',     onPodTime);
    pod.addEventListener('durationchange', onPodDur);
    pod.addEventListener('play',           onPodPlay);
    pod.addEventListener('pause',          onPodPause);
    pod.addEventListener('waiting',        onPodWait);
    pod.addEventListener('canplay',        onPodCan);
    pod.addEventListener('error',          onPodErr);

    // Sync UI state with whatever the elements are currently doing (handles
    // returning to RadioPage while audio was already playing).
    if (!audio.paused) { setPlaying(true); }
    if (audio.currentTime) setCT(audio.currentTime);
    if (audio.duration)    setDur(audio.duration);

    return () => {
      // Detach listeners only — do NOT pause or clear src.
      audio.removeEventListener('timeupdate',     onMusicTime);
      audio.removeEventListener('durationchange', onMusicDur);
      audio.removeEventListener('play',           onMusicPlay);
      audio.removeEventListener('pause',          onMusicPause);
      audio.removeEventListener('waiting',        onMusicWait);
      audio.removeEventListener('canplay',        onMusicCan);
      audio.removeEventListener('error',          onMusicErr);

      pod.removeEventListener('timeupdate',     onPodTime);
      pod.removeEventListener('durationchange', onPodDur);
      pod.removeEventListener('play',           onPodPlay);
      pod.removeEventListener('pause',          onPodPause);
      pod.removeEventListener('waiting',        onPodWait);
      pod.removeEventListener('canplay',        onPodCan);
      pod.removeEventListener('error',          onPodErr);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Ducking — ramp audio.volume on isSpeaking changes ────────────────────
  useEffect(() => {
    console.log('[Duck] effect fired — isSpeaking:', moderator.isSpeaking, '| audio.volume:', audioRef.current?.volume ?? 'no audio');
    const audio = audioRef.current;
    if (!audio) return;
    cancelRampRef.current?.();

    if (moderator.isSpeaking) {
      console.log(`[Duck] duckDown() → ${DUCK_LEVEL} over 1000ms`);
      cancelRampRef.current = rampVolume(audio, DUCK_LEVEL, 1000);
    } else {
      const target = mutedRef.current ? 0 : volumeRef.current;
      console.log(`[Duck] fadeBack() → ${target} over 2000ms`);
      cancelRampRef.current = rampVolume(audio, target, 2000);
    }
    return () => cancelRampRef.current?.();
  }, [moderator.isSpeaking]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Volume/mute slider (when not ducked) ─────────────────────────────────
  // Only fires on user volume/mute changes — NOT on isSpeaking changes, so the
  // ducking fade-back ramp started above is not immediately cancelled.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || moderator.isSpeaking) return;
    cancelRampRef.current?.();
    audio.volume = muted ? 0 : volume;
  }, [volume, muted]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Core loop — stable, reads everything via refs ─────────────────────────
  const advanceLoop = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;

    console.log('[Loop] advanceLoop() started, idxRef:', idxRef.current);

    while (runningRef.current) {
      const tracks     = tracksRef.current;
      const currentIdx = idxRef.current;
      const t          = tracks[currentIdx];

      if (!tracks.length || !t) {
        console.log('[Loop] no tracks — exiting');
        break;
      }

      console.log(`[Loop] loading track ${currentIdx}: "${t.name}" by ${t.artist}`);

      loopGenRef.current++; // invalidate any listeners from the previous iteration
      audio.pause();
      audio.src    = t.liveUrl;
      audio.volume = DUCK_LEVEL; // always start ducked; fade restored after speech
      audio.load();
      setCT(0);
      setDur(t.duration || 0);
      setIdx(currentIdx);

      // Keep Now Playing showing the current music track
      nowPlayingRef.current = { kind: 'music', track: t };
      setNowPlaying({ kind: 'music', track: t });

      try {
        await audio.play();
        console.log('[Loop] audio.play() resolved at duck level');
      } catch (e) {
        console.error('[Loop] audio.play() failed:', e);
        runningRef.current = false;
        break;
      }

      if (!runningRef.current) break;

      // 2. Speak over the playing music; when isSpeaking flips false the
      //    ducking useEffect automatically fades volume back to target.
      if (!greetedRef.current) {
        greetedRef.current = true;
        console.log('[Loop] greeting + track intro over music');
        await moderatorRef.current.speakGreeting(nameRef.current);
        await sleep(400);
        await moderatorRef.current.speakTrackIntro(t);
      } else if (silentCountRef.current >= silentBudgetRef.current && recentTracksRef.current.length > 0) {
        // Time for a DJ break — review recent tracks and intro this one
        const played = recentTracksRef.current;
        recentTracksRef.current = [];
        console.log('[Loop] moderation — speakReviewAndIntro over music');
        await moderatorRef.current.speakReviewAndIntro(played, t);
        // Reset the silent counter AFTER speaking so the podcast check below
        // still has access to the accumulated count before we cleared it.
        silentCountRef.current  = 0;
        silentBudgetRef.current = randInt(1, 2);
      } else {
        // No speech this track — fade up immediately
        console.log('[Loop] no speech — fading up now');
        cancelRampRef.current?.();
        const target = mutedRef.current ? 0 : volumeRef.current;
        cancelRampRef.current = rampVolume(audio, target, 1000);
      }

      if (!runningRef.current) { console.log('[Loop] runningRef false — exiting'); break; }

      // 3. Wait for the track to end naturally or for the user to pause.
      //    Each iteration gets a unique generation number. Any listener that
      //    fires after loopGenRef has moved on (stale) simply ignores itself.
      const myGen = ++loopGenRef.current;
      const endedNaturally = await new Promise<boolean>(resolve => {
        const onEnded = () => {
          if (loopGenRef.current !== myGen) return; // stale — a new iteration started
          cleanup();
          console.log(`[Loop] ended naturally (gen ${myGen})`);
          resolve(true);
        };
        const onPause = () => {
          if (loopGenRef.current !== myGen) return; // stale
          if (!runningRef.current) {
            // handlePause() sets runningRef=false then calls audio.pause()
            cleanup();
            console.log(`[Loop] paused by user (gen ${myGen})`);
            resolve(false);
          }
          // else: browser fires pause just before ended on natural end — wait for ended
        };
        function cleanup() {
          audio.removeEventListener('ended', onEnded);
          audio.removeEventListener('pause', onPause);
        }
        audio.addEventListener('ended', onEnded);
        audio.addEventListener('pause', onPause);
      });

      if (!runningRef.current) { console.log('[Loop] runningRef false — exiting'); break; }

      if (endedNaturally) {
        // Accumulate this track in the recents list and increment the silent counter
        recentTracksRef.current = [...recentTracksRef.current, t].slice(-2);
        silentCountRef.current++;

        const nextMusicIdx = (currentIdx + 1) % tracks.length;
        idxRef.current     = nextMusicIdx;
        console.log(`[Loop] index advanced ${currentIdx} → ${nextMusicIdx}`);
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

          const nextMusicTrack = tracksRef.current[nextMusicIdx];

          console.log(`[Loop] podcast slot — "${episode.title}" from ${episode.feedTitle}`);

          // ── Transition: moderator introduces the podcast episode ────────────
          // speakPodcastTransition takes (podcastTitle, hostName) — we pass
          // the episode title as the segment name and the show name as "host".
          await moderatorRef.current.speakPodcastTransition(episode.title, episode.feedTitle);
          if (!runningRef.current) break;

          // ── Load podcast onto the dedicated CORS-enabled audio element ────
          const pod = podAudioRef.current;
          if (!pod) {
            console.warn('[Loop] podAudioRef not ready — skipping podcast');
          } else {
            loopGenRef.current++;

            // Pause music while podcast plays
            audio.pause();

            // Set src AFTER crossOrigin is already set (done at element creation)
            pod.src    = episode.audioUrl;
            pod.volume = mutedRef.current ? 0 : volumeRef.current;
            pod.load();
            setCT(0);
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
              console.error('[Loop] podcast play failed:', e);
              nowPlayingRef.current = { kind: 'music', track: t };
              setNowPlaying({ kind: 'music', track: t });
            }

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
                {
                  isRunning: () => runningRef.current,

                  speakCommentary: async (script) => {
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
              );
            }

            // ── Episode finished (naturally or user paused) ────────────────
            pod.pause();
            pod.src = '';

            // ── Outro: bridge back to music ───────────────────────────────
            if (runningRef.current && nextMusicTrack) {
              await moderatorRef.current.speakPodcastOutro(episode, nextMusicTrack);
            }
          }

          // Clear the recent-tracks buffer so the review after a podcast
          // doesn't reference stale pre-podcast tracks.
          recentTracksRef.current = [];
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
    await advanceLoop();
  }, [advanceLoop]);

  // ── Public controls ───────────────────────────────────────────────────────
  const handlePlay = useCallback(() => {
    // If the loop is already running (e.g. we navigated away and came back),
    // there's nothing to do — audio is already playing in the background.
    if (runningRef.current) return;
    if (!greetedRef.current) {
      startRadio();
    } else {
      runningRef.current = true;
      audioRef.current?.play().catch(e => console.error('[Play] resume failed:', e));
      advanceLoop();
    }
  }, [startRadio, advanceLoop]);

  const handlePause = useCallback(() => {
    console.log('[Pause] handlePause()');
    runningRef.current = false;
    moderatorRef.current.stop();
    audioRef.current?.pause();
  }, []);

  const jumpTo = useCallback((newIdx: number) => {
    console.log('[JumpTo]', newIdx);
    const wasRunning = runningRef.current;
    runningRef.current = false;            // break the loop's pause listener
    audioRef.current?.pause();             // fires 'pause' → resolves inner promise
    idxRef.current = newIdx;
    setIdx(newIdx);
    if (wasRunning) {
      setTimeout(() => {
        runningRef.current = true;
        advanceLoop();
      }, 150);
    }
  }, [advanceLoop]);

  const handlePrev   = useCallback(() => jumpTo((idxRef.current - 1 + tracksRef.current.length) % tracksRef.current.length), [jumpTo]);
  const handleNext   = useCallback(() => jumpTo((idxRef.current + 1) % tracksRef.current.length), [jumpTo]);
  const handleSelect = useCallback((i: number) => jumpTo(i), [jumpTo]);

  // ── Drag-and-drop handlers ─────────────────────────────────────────────────
  const handleDragEnd = useCallback((result: DropResult) => {
    const { source, destination, droppableId } = result;
    if (!destination) return; // dropped outside a list
    if (source.index === destination.index && source.droppableId === destination.droppableId) return;

    if (droppableId === 'playlist') {
      setOrderedTracks(prev => {
        const next = [...prev];
        const [moved] = next.splice(source.index, 1);
        next.splice(destination.index, 0, moved);

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

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const r = (e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.offsetWidth;
    audio.currentTime = Math.max(0, Math.min(1, r)) * duration;
  };

  // ── Derived UI ────────────────────────────────────────────────────────────
  // Use orderedTracks so the displayed track matches what the loop is playing
  const track        = (orderedTracks.length > 0 ? orderedTracks : tracks)[idx];
  const pct          = duration > 0 ? (currentTime / duration) * 100 : 0;
  const isModerating = moderator.isSpeaking || moderator.isGenerating;
  const statusLabel  = moderator.isGenerating ? 'WRITING' : moderator.isSpeaking ? 'ON AIR' : buffering ? 'BUFFERING' : playing ? 'LIVE' : 'PAUSED';
  const statusColor  = isModerating ? 'bg-amber-400' : playing ? 'bg-red-500 animate-pulse' : 'bg-white/30';

  return (
    <div className="min-h-screen gradient-bg text-white relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 left-1/3 w-96 h-96 bg-purple-900/20 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/3 w-80 h-80 bg-violet-900/20 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 max-w-2xl mx-auto px-4 py-8 space-y-6">

        {/* Header */}
        <header className="flex items-center justify-between fade-in-up">
          <div>
            <button onClick={() => navigate('/')} className="text-xs tracking-[0.25em] text-purple-400 uppercase font-semibold hover:text-purple-300 transition-colors flex items-center gap-1.5">
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
          <div className="flex items-center gap-5 mb-6">
            <div className="relative flex-shrink-0">
              {nowPlaying?.kind === 'podcast' ? (
                /* Podcast: static icon disc — no spin */
                <div className="w-24 h-24 rounded-full overflow-hidden border-4 border-amber-700/60 shadow-2xl bg-amber-900/30 flex items-center justify-center text-4xl select-none">
                  🎙️
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-6 h-6 rounded-full bg-black/40 border-2 border-amber-400/20" />
                  </div>
                </div>
              ) : (
                /* Music: spinning vinyl */
                <div className={`w-24 h-24 rounded-full overflow-hidden border-4 border-gray-700 shadow-2xl bg-gray-800 ${(playing && !isModerating) ? 'vinyl-spin' : 'vinyl-spin paused'}`}>
                  {track?.artworkUrl && <img src={track.artworkUrl} alt={track.name} className="w-full h-full object-cover" onError={e => (e.currentTarget.style.display = 'none')} />}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-6 h-6 rounded-full bg-black/60 border-2 border-white/20" />
                  </div>
                </div>
              )}
              {(playing && !isModerating) && (
                <div className={`absolute inset-0 rounded-full blur-xl animate-pulse pointer-events-none ${nowPlaying?.kind === 'podcast' ? 'bg-amber-500/15' : 'bg-purple-600/15'}`} />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-xs font-semibold uppercase tracking-widest ${nowPlaying?.kind === 'podcast' ? 'text-amber-400' : 'text-purple-400'}`}>
                  {nowPlaying?.kind === 'podcast' ? 'Now Playing · Podcast' : 'Now Playing'}
                </span>
                {nowPlaying?.kind === 'music' && nowPlaying.track && (
                  <a href={`https://wavlake.com/track/${nowPlaying.track.id}`} target="_blank" rel="noopener noreferrer" className="text-white/20 hover:text-purple-400 transition-colors">
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                )}
              </div>
              {isLoading ? (
                <div className="space-y-2"><Skeleton className="h-5 w-36 bg-white/10"/><Skeleton className="h-3.5 w-24 bg-white/10"/></div>
              ) : isError ? (
                <p className="text-red-400 text-sm">Couldn't load tracks</p>
              ) : nowPlaying?.kind === 'podcast' ? (
                <>
                  <h3 className="text-xl font-bold truncate">{nowPlaying.episode.title}</h3>
                  <p className="text-white/60 text-sm truncate">{nowPlaying.episode.feedTitle}</p>
                  <span className="inline-block mt-2 text-xs text-amber-400/80 bg-amber-900/20 border border-amber-700/30 rounded-full px-3 py-0.5">🎙️ Podcast</span>
                </>
              ) : nowPlaying?.kind === 'music' ? (
                <>
                  <h3 className="text-xl font-bold truncate">{nowPlaying.track.name}</h3>
                  <p className="text-white/60 text-sm truncate">{nowPlaying.track.artist}</p>
                  {nowPlaying.track.albumTitle && <span className="inline-block mt-2 text-xs text-purple-300/70 bg-purple-900/30 border border-purple-700/30 rounded-full px-3 py-0.5">{nowPlaying.track.albumTitle}</span>}
                </>
              ) : track ? (
                /* Fallback before loop starts */
                <>
                  <h3 className="text-xl font-bold truncate">{track.name}</h3>
                  <p className="text-white/60 text-sm truncate">{track.artist}</p>
                  {track.albumTitle && <span className="inline-block mt-2 text-xs text-purple-300/70 bg-purple-900/30 border border-purple-700/30 rounded-full px-3 py-0.5">{track.albumTitle}</span>}
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
            <div className="w-full h-1.5 bg-white/10 rounded-full cursor-pointer group" onClick={handleSeek}>
              <div className="h-full rounded-full progress-bar-inner relative" style={{ width: `${pct}%` }}>
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white shadow-lg opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>
            <div className="flex justify-between mt-1.5 text-xs text-white/30">
              <span>{fmt(currentTime)}</span>
              <span>{fmt(duration || track?.duration || 0)}</span>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-1">
              <button onClick={() => setMuted(m => !m)} className="text-white/40 hover:text-white/80 transition-colors" aria-label={muted ? 'Unmute' : 'Mute'}>
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  {muted
                    ? <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                    : <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                  }
                </svg>
              </button>
              <input type="range" min={0} max={1} step={0.02} value={muted ? 0 : volume}
                onChange={e => { setVol(+e.target.value); setMuted(false); }}
                className="w-20 h-1" aria-label="Volume" />
            </div>
            <div className="flex items-center gap-4">
              <button onClick={handlePrev} disabled={isLoading} className="w-10 h-10 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-all disabled:opacity-30" aria-label="Previous">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
              </button>
              <button onClick={playing ? handlePause : handlePlay} disabled={isLoading || (orderedTracks.length === 0 && tracks.length === 0)}
                className="w-14 h-14 rounded-full bg-gradient-to-br from-violet-600 to-purple-700 flex items-center justify-center glow-purple hover:scale-105 active:scale-95 transition-all shadow-lg disabled:opacity-40"
                aria-label={playing ? 'Pause' : 'Play'}>
                {buffering && !isModerating
                  ? <svg className="w-5 h-5 text-white animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                  : playing
                    ? <svg className="w-6 h-6 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                    : <svg className="w-6 h-6 text-white ml-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                }
              </button>
              <button onClick={handleNext} disabled={isLoading} className="w-10 h-10 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-all disabled:opacity-30" aria-label="Next">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
              </button>
            </div>
            <div className="flex-1 flex justify-end">
              <a href="https://wavlake.com" target="_blank" rel="noopener noreferrer" className="text-white/20 hover:text-purple-400 transition-colors text-xs">⚡ Wavlake</a>
            </div>
          </div>
        </div>

        {/* Genre selector — directly below player, above podcasts */}
        <div className="fade-in-up-delay-3 space-y-3">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-semibold text-white/60 uppercase tracking-widest">Genres</h3>
            {!isAllSelected && (
              <button
                onClick={selectAll}
                className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
              >
                All
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {GENRES.map(genre => {
              const active = selectedIds.includes(genre.id);
              return (
                <button
                  key={genre.id}
                  onClick={() => toggle(genre.id)}
                  aria-pressed={active}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold tracking-wide border transition-all duration-150 select-none
                    ${active
                      ? 'bg-purple-600/30 border-purple-500/60 text-purple-200 shadow-sm shadow-purple-900/40'
                      : 'bg-white/5 border-white/10 text-white/40 hover:border-white/25 hover:text-white/60'
                    }`}
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
          {orderedEpisodes.length > 0 && (
            <div className="fade-in-up-delay-3 space-y-3">
              <div className="flex items-center justify-between px-1">
                <h3 className="text-sm font-semibold text-white/60 uppercase tracking-widest">Coming Up · Podcasts</h3>
                <span className="text-xs text-amber-400/60">drag to reorder</span>
              </div>
              <Droppable droppableId="podcast-queue">
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className={`space-y-2 rounded-2xl transition-colors ${snapshot.isDraggingOver ? 'bg-amber-900/10' : ''}`}
                  >
                    {orderedEpisodes.slice(0, 5).map((ep, i) => (
                      <Draggable key={ep.id} draggableId={`ep-${ep.id}`} index={i}>
                        {(drag, dragSnapshot) => (
                          <div
                            ref={drag.innerRef}
                            {...drag.draggableProps}
                            className={`glass-card rounded-2xl p-4 flex items-start gap-4 transition-all
                              ${dragSnapshot.isDragging ? 'shadow-2xl shadow-amber-900/30 scale-[1.02] ring-1 ring-amber-500/30' : ''}
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
                                {ep.duration > 0 && <>
                                  <span className="text-xs text-white/25">·</span>
                                  <span className="text-xs text-white/40">{fmt(ep.duration)}</span>
                                </>}
                                {i === 0 && <span className="text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-full px-2 py-0.5">Up next</span>}
                              </div>
                              <p className="text-sm font-semibold text-white truncate">{ep.title}</p>
                              <p className="text-xs text-white/40 mt-0.5">{ep.feedTitle}</p>
                            </div>
                          </div>
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
              <h3 className="text-sm font-semibold text-white/60 uppercase tracking-widest">Playlist</h3>
              <span className="text-xs text-purple-400">{isLoading ? '…' : `${orderedTracks.length || tracks.length} tracks`}</span>
            </div>
            <div className="glass-card rounded-2xl overflow-hidden">
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
                      {orderedTracks.map((t, i) => (
                        <Draggable key={t.id} draggableId={`track-${t.id}`} index={i}>
                          {(drag, dragSnapshot) => (
                            <div
                              ref={drag.innerRef}
                              {...drag.draggableProps}
                              className={`flex items-center gap-3 px-4 py-3.5 transition-all
                                ${i === idx ? 'bg-purple-900/20' : 'hover:bg-white/5'}
                                ${dragSnapshot.isDragging ? 'shadow-xl shadow-purple-900/30 scale-[1.01] bg-white/5 ring-1 ring-purple-500/30 rounded-xl' : ''}
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
                                onClick={() => handleSelect(i)}
                                className="w-6 flex items-center justify-center flex-shrink-0"
                                aria-label={i === idx ? 'Currently playing' : `Play ${t.name}`}
                              >
                                {i === idx
                                  ? <div className="flex items-end gap-0.5 h-5">{[1,2,3].map(b => <div key={b} className={`w-1 rounded-full bg-purple-400 wave-bar ${(!playing || isModerating) ? 'paused' : ''}`} style={{ height: '4px' }} />)}</div>
                                  : <span className="text-white/30 text-xs hover:text-white/60">{i + 1}</span>
                                }
                              </button>

                              {/* Artwork */}
                              <button onClick={() => handleSelect(i)} className="w-9 h-9 rounded-lg overflow-hidden flex-shrink-0 bg-white/5 flex-shrink-0">
                                <img src={t.artworkUrl} alt={t.name} className="w-full h-full object-cover" loading="lazy" onError={e => (e.currentTarget.style.display = 'none')} />
                              </button>

                              {/* Info */}
                              <button onClick={() => handleSelect(i)} className="flex-1 min-w-0 text-left">
                                <p className={`text-sm font-medium truncate ${i === idx ? 'text-purple-300' : 'text-white/80'}`}>{t.name}</p>
                                <p className="text-xs text-white/40 truncate">{t.artist}</p>
                              </button>

                              <span className="text-xs text-white/30 flex-shrink-0 pr-1">{fmt(t.duration)}</span>
                            </div>
                          )}
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
