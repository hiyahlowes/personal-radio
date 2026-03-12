import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useWavlakeTracks, type WavlakeTrack } from '@/hooks/useWavlakeTracks';
import { useRadioModerator } from '@/hooks/useRadioModerator';
import { Skeleton } from '@/components/ui/skeleton';

// ─── Ducking via audio.volume + setInterval ───────────────────────────────────
// Note: Web Audio API MediaElementAudioSourceNode requires CORS headers on the
// media URL. Wavlake's CDN does not send them, so we use audio.volume directly.
const DUCK_LEVEL  = 0.15;
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

const UPCOMING = [
  { type: 'podcast', title: 'Deep Focus: The Science of Flow States', host: 'Dr. Maya Chen', duration: '18 min', icon: '🎙️' },
  { type: 'music',   title: 'Curated: Late Night Vibes',             host: 'AI DJ',        duration: '45 min', icon: '🎵' },
  { type: 'podcast', title: 'Tech Horizons: AI in Creative Work',    host: 'Sam & Priya',  duration: '32 min', icon: '🎙️' },
];

// ─── Component ────────────────────────────────────────────────────────────────
export function RadioPage() {
  const [params]  = useSearchParams();
  const navigate  = useNavigate();
  const name      = params.get('name') || 'Listener';
  const firstName = name.split(' ')[0];

  const { data: tracks = [], isLoading, isError } = useWavlakeTracks();
  const moderator = useRadioModerator();

  // ── UI state ──────────────────────────────────────────────────────────────
  const [idx, setIdx]         = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuf]   = useState(false);
  const [currentTime, setCT]  = useState(0);
  const [duration, setDur]    = useState(0);
  const [volume, setVol]      = useState(0.9);
  const [muted, setMuted]     = useState(false);

  // ── Stable refs ───────────────────────────────────────────────────────────
  const audioRef         = useRef<HTMLAudioElement | null>(null);
  const cancelRampRef    = useRef<(() => void) | null>(null);
  const tracksRef        = useRef<WavlakeTrack[]>([]);
  const runningRef       = useRef(false);
  const greetedRef       = useRef(false);
  const idxRef           = useRef(0);
  const silentCountRef   = useRef(0);
  const silentBudgetRef  = useRef(randInt(1, 2));
  const recentTracksRef  = useRef<WavlakeTrack[]>([]);
  const moderatorRef     = useRef(moderator);
  const nameRef          = useRef(name);
  const volumeRef        = useRef(0.9);
  const mutedRef         = useRef(false);

  // Sync refs to latest state/props
  useEffect(() => { tracksRef.current    = tracks;    }, [tracks]);
  useEffect(() => { moderatorRef.current = moderator; }, [moderator]);
  useEffect(() => { nameRef.current      = name;      }, [name]);
  useEffect(() => { volumeRef.current    = volume;    }, [volume]);
  useEffect(() => { mutedRef.current     = muted;     }, [muted]);

  // ── Audio element — created once, no crossOrigin ──────────────────────────
  useEffect(() => {
    const audio      = new Audio();
    audio.preload    = 'metadata';
    // Do NOT set audio.crossOrigin — Wavlake CDN has no CORS headers and
    // crossOrigin='anonymous' would cause all requests to fail.
    audioRef.current = audio;

    audio.addEventListener('timeupdate',     () => setCT(audio.currentTime));
    audio.addEventListener('durationchange', () => setDur(audio.duration || 0));
    audio.addEventListener('play',           () => { console.log('[Music] play'); setPlaying(true); });
    audio.addEventListener('pause',          () => { console.log('[Music] pause'); setPlaying(false); });
    audio.addEventListener('ended',          () => console.log('[Music] ended'));
    audio.addEventListener('waiting',        () => setBuf(true));
    audio.addEventListener('canplay',        () => setBuf(false));
    audio.addEventListener('error',          () => console.error('[Music] error', audio.error?.message));

    return () => { audio.pause(); audio.src = ''; };
  }, []);

  // ── Ducking — ramp audio.volume on isSpeaking changes ────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    cancelRampRef.current?.();

    if (moderator.isSpeaking) {
      console.log('[Duck] duckDown() → 0.15 over 1000ms');
      cancelRampRef.current = rampVolume(audio, DUCK_LEVEL, 1000);
    } else {
      const target = mutedRef.current ? 0 : volumeRef.current;
      console.log(`[Duck] fadeBack() → ${target} over 2000ms`);
      cancelRampRef.current = rampVolume(audio, target, 2000);
    }
    return () => cancelRampRef.current?.();
  }, [moderator.isSpeaking]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Volume/mute slider (when not ducked) ─────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || moderator.isSpeaking) return;
    cancelRampRef.current?.();
    audio.volume = muted ? 0 : volume;
  }, [volume, muted, moderator.isSpeaking]);

  // ── Core loop — stable, reads everything via refs ─────────────────────────
  const advanceLoop = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;

    console.log('[Loop] advanceLoop() started, idxRef:', idxRef.current);

    while (runningRef.current) {
      const tracks    = tracksRef.current;
      const currentIdx = idxRef.current;
      const t         = tracks[currentIdx];

      if (!tracks.length || !t) {
        console.log('[Loop] no tracks — exiting');
        break;
      }

      console.log(`[Loop] loading track ${currentIdx}: "${t.name}" by ${t.artist}`);
      console.log(`[Loop] src: ${t.liveUrl}`);

      audio.pause();
      audio.src    = t.liveUrl;
      audio.volume = mutedRef.current ? 0 : volumeRef.current;
      audio.load();
      setCT(0);
      setDur(t.duration || 0);
      setIdx(currentIdx);

      try {
        await audio.play();
        console.log('[Loop] audio.play() resolved — track is playing');
      } catch (e) {
        console.error('[Loop] audio.play() failed:', e);
        runningRef.current = false;
        break;
      }

      // Wait for track to finish naturally, or user pause
      const endedNaturally = await new Promise<boolean>(resolve => {
        const onEnded = () => { cleanup(); console.log('[Loop] ended naturally'); resolve(true);  };
        const onPause = () => { cleanup(); console.log('[Loop] paused by user'); resolve(false); };
        function cleanup() {
          audio.removeEventListener('ended', onEnded);
          audio.removeEventListener('pause', onPause);
        }
        audio.addEventListener('ended', onEnded);
        audio.addEventListener('pause', onPause);
      });

      if (!runningRef.current) { console.log('[Loop] runningRef false — exiting'); break; }

      if (endedNaturally) {
        recentTracksRef.current = [...recentTracksRef.current, t].slice(-2);
        silentCountRef.current++;

        const nextIdx   = (currentIdx + 1) % tracks.length;
        idxRef.current  = nextIdx;
        const nextTrack = tracks[nextIdx];

        if (nextTrack && silentCountRef.current >= silentBudgetRef.current) {
          silentCountRef.current  = 0;
          silentBudgetRef.current = randInt(1, 2);
          const played = recentTracksRef.current;
          recentTracksRef.current = [];
          console.log('[Loop] moderation break — speakReviewAndIntro');
          await moderatorRef.current.speakReviewAndIntro(played, nextTrack);
          await sleep(800);
        }
      }
      // loop continues — picks up idxRef.current on next iteration
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

    if (!greetedRef.current) {
      greetedRef.current = true;
      const first = tracksRef.current[0];
      console.log('[Start] speaking greeting');
      await moderatorRef.current.speakGreeting(nameRef.current);
      await sleep(400);
      console.log('[Start] speaking track intro');
      await moderatorRef.current.speakTrackIntro(first);
      await sleep(500);
    }

    if (!runningRef.current) return; // paused during greeting
    console.log('[Start] entering advanceLoop');
    await advanceLoop();
  }, [advanceLoop]);

  // ── Public controls ───────────────────────────────────────────────────────
  const handlePlay = useCallback(() => {
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

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const r = (e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.offsetWidth;
    audio.currentTime = Math.max(0, Math.min(1, r)) * duration;
  };

  // ── Derived UI ────────────────────────────────────────────────────────────
  const track        = tracks[idx];
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
          <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-full px-4 py-2">
            <div className={`w-2 h-2 rounded-full ${statusColor}`} />
            <span className="text-xs font-semibold tracking-wider text-white/60">{statusLabel}</span>
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
              <div className={`w-24 h-24 rounded-full overflow-hidden border-4 border-gray-700 shadow-2xl bg-gray-800 ${(playing && !isModerating) ? 'vinyl-spin' : 'vinyl-spin paused'}`}>
                {track?.artworkUrl && <img src={track.artworkUrl} alt={track.name} className="w-full h-full object-cover" onError={e => (e.currentTarget.style.display = 'none')} />}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="w-6 h-6 rounded-full bg-black/60 border-2 border-white/20" />
                </div>
              </div>
              {(playing && !isModerating) && <div className="absolute inset-0 rounded-full bg-purple-600/15 blur-xl animate-pulse pointer-events-none" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-semibold text-purple-400 uppercase tracking-widest">Now Playing</span>
                {track && (
                  <a href={`https://wavlake.com/track/${track.id}`} target="_blank" rel="noopener noreferrer" className="text-white/20 hover:text-purple-400 transition-colors">
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                )}
              </div>
              {isLoading ? (
                <div className="space-y-2"><Skeleton className="h-5 w-36 bg-white/10"/><Skeleton className="h-3.5 w-24 bg-white/10"/></div>
              ) : isError ? (
                <p className="text-red-400 text-sm">Couldn't load tracks</p>
              ) : track ? (
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
              <button onClick={playing ? handlePause : handlePlay} disabled={isLoading || tracks.length === 0}
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

        {/* Coming Up */}
        <div className="fade-in-up-delay-3 space-y-3">
          <h3 className="text-sm font-semibold text-white/60 uppercase tracking-widest px-1">Coming Up</h3>
          {UPCOMING.map((seg, i) => (
            <div key={i} className="glass-card rounded-2xl p-4 flex items-start gap-4">
              <div className="w-11 h-11 rounded-xl bg-white/5 flex items-center justify-center flex-shrink-0 text-xl">{seg.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`text-xs font-bold uppercase tracking-wider ${seg.type === 'podcast' ? 'text-amber-400' : 'text-purple-400'}`}>{seg.type === 'podcast' ? 'Podcast' : 'Music Set'}</span>
                  <span className="text-xs text-white/25">·</span>
                  <span className="text-xs text-white/40">{seg.duration}</span>
                </div>
                <p className="text-sm font-semibold text-white truncate">{seg.title}</p>
                <p className="text-xs text-white/40 mt-0.5">{seg.host}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Playlist */}
        <div className="fade-in-up-delay-3 space-y-3">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-semibold text-white/60 uppercase tracking-widest">Playlist</h3>
            <span className="text-xs text-purple-400">{isLoading ? '…' : `${tracks.length} tracks`}</span>
          </div>
          <div className="glass-card rounded-2xl overflow-hidden divide-y divide-white/5">
            {isLoading ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                <Skeleton className="w-8 h-8 rounded-lg bg-white/10"/>
                <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-3/5 bg-white/10"/><Skeleton className="h-3 w-2/5 bg-white/10"/></div>
                <Skeleton className="h-3 w-8 bg-white/10"/>
              </div>
            )) : isError ? (
              <div className="px-4 py-8 text-center"><p className="text-white/40 text-sm">Couldn't load playlist from Wavlake.</p></div>
            ) : tracks.map((t, i) => (
              <button key={t.id} onClick={() => handleSelect(i)}
                className={`w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-white/5 transition-colors group ${i === idx ? 'bg-purple-900/20' : ''}`}>
                <div className="w-8 flex items-center justify-center flex-shrink-0">
                  {i === idx
                    ? <div className="flex items-end gap-0.5 h-5">{[1,2,3].map(b => <div key={b} className={`w-1 rounded-full bg-purple-400 wave-bar ${(!playing || isModerating) ? 'paused' : ''}`} style={{ height: '4px' }} />)}</div>
                    : <span className="text-white/30 text-sm group-hover:text-white/60">{i + 1}</span>
                  }
                </div>
                <div className="w-9 h-9 rounded-lg overflow-hidden flex-shrink-0 bg-white/5">
                  <img src={t.artworkUrl} alt={t.name} className="w-full h-full object-cover" loading="lazy" onError={e => (e.currentTarget.style.display = 'none')} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate ${i === idx ? 'text-purple-300' : 'text-white/80'}`}>{t.name}</p>
                  <p className="text-xs text-white/40 truncate">{t.artist}</p>
                </div>
                <span className="text-xs text-white/30 flex-shrink-0">{fmt(t.duration)}</span>
              </button>
            ))}
          </div>
        </div>

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
