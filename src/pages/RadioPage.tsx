import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useShakespeare } from '@/hooks/useShakespeare';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useWavlakeTracks, type WavlakeTrack } from '@/hooks/useWavlakeTracks';
import { Skeleton } from '@/components/ui/skeleton';

// ─── Podcast / coming-up segment placeholders ────────────────────────────────
const UPCOMING_SEGMENTS = [
  {
    type: 'podcast',
    title: 'Deep Focus: The Science of Flow States',
    host: 'Dr. Maya Chen',
    duration: '18 min',
    description: 'Explore how top performers enter the zone and stay there.',
    icon: '🎙️',
  },
  {
    type: 'music',
    title: 'Curated: Late Night Vibes',
    host: 'AI DJ',
    duration: '45 min',
    description: 'A handpicked set of downtempo tracks for winding down.',
    icon: '🎵',
  },
  {
    type: 'podcast',
    title: 'Tech Horizons: AI in Creative Work',
    host: 'Sam & Priya',
    duration: '32 min',
    description: 'How artificial intelligence is reshaping art, music and writing.',
    icon: '🎙️',
  },
];

// ─── Time-of-day helpers ─────────────────────────────────────────────────────
function getTimeOfDay(): 'morning' | 'afternoon' | 'evening' | 'night' {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

function buildFallbackGreeting(name: string): string {
  const tod = getTimeOfDay();
  const firstName = name.split(' ')[0];
  const greetings: Record<typeof tod, string> = {
    morning: `Good morning, ${firstName}. Rise and shine — your personal station is live and the first tracks of the day are queued up. Pour yourself something warm and enjoy the ride.`,
    afternoon: `Good afternoon, ${firstName}. The day's in full swing and so is your playlist. Sit back, tune in, and let the music carry you through the rest of the afternoon.`,
    evening: `Good evening, ${firstName}. The day's winding down — a perfect time to let some great music take over. Your personal station has a beautiful set lined up for you tonight.`,
    night: `Hey, ${firstName}. Burning the midnight oil? You've got good company — your station is on and the night playlist is ready. Enjoy the quiet hours.`,
  };
  return greetings[tod];
}

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Component ───────────────────────────────────────────────────────────────
export function RadioPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const name = searchParams.get('name') || 'Listener';
  const firstName = name.split(' ')[0];

  // Track list from Wavlake
  const { data: tracks = [], isLoading: tracksLoading, isError: tracksError } = useWavlakeTracks();

  // Player state
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);

  // AI Greeting state
  const [greeting, setGreeting] = useState('');
  const [isGreetingLoading, setIsGreetingLoading] = useState(true);
  const [greetingNote, setGreetingNote] = useState('');

  // Audio element ref
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const { sendChatMessage, isAuthenticated } = useShakespeare();
  const { user } = useCurrentUser();

  const currentTrack: WavlakeTrack | undefined = tracks[currentIndex];

  // ── AI Greeting generation ───────────────────────────────────────────────
  const generateGreeting = useCallback(async () => {
    setIsGreetingLoading(true);
    setGreetingNote('');

    if (!isAuthenticated) {
      // No login – show a good deterministic fallback immediately
      setGreeting(buildFallbackGreeting(name));
      setGreetingNote('Log in with Nostr for an AI-personalized greeting');
      setIsGreetingLoading(false);
      return;
    }

    try {
      const tod = getTimeOfDay();
      const now = new Date();
      const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
      const dateFull = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

      const response = await sendChatMessage(
        [
          {
            role: 'system',
            content:
              'You are a warm, charismatic AI radio host for PR – Personal Radio, a premium personal radio station. Speak naturally, like a real radio DJ. Be brief (2-3 sentences), uplifting, and personal. Reference the time of day and day of week naturally. No emojis. No quotation marks around your response.',
          },
          {
            role: 'user',
            content: `Write a ${tod} greeting for a listener named ${name}. Today is ${dayName}, ${dateFull}. Make it feel warm, personal, and radio-authentic — like they just tuned in to their favourite station.`,
          },
        ],
        'shakespeare',
        { max_tokens: 120 }
      );

      const text = response.choices[0]?.message?.content;
      if (typeof text === 'string' && text.trim()) {
        setGreeting(text.trim());
      } else {
        setGreeting(buildFallbackGreeting(name));
      }
    } catch {
      setGreeting(buildFallbackGreeting(name));
      setGreetingNote('Using offline greeting — check your connection for AI greetings');
    } finally {
      setIsGreetingLoading(false);
    }
  }, [name, isAuthenticated, sendChatMessage]);

  useEffect(() => {
    generateGreeting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Audio element setup ──────────────────────────────────────────────────
  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = 'metadata';
    }
    const audio = audioRef.current;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => setDuration(audio.duration || 0);
    const onEnded = () => advanceTrack(1);
    const onWaiting = () => setIsBuffering(true);
    const onCanPlay = () => setIsBuffering(false);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('canplay', onCanPlay);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
    };
    // advanceTrack is defined below, exclude from deps to avoid loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load track when currentIndex or tracks change ────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;

    const wasPlaying = isPlaying;
    audio.pause();
    audio.src = currentTrack.liveUrl;
    audio.load();
    setCurrentTime(0);
    setDuration(currentTrack.duration || 0);

    if (wasPlaying) {
      audio.play().catch(() => {
        // autoplay blocked – that's fine
      });
    }
    // isPlaying intentionally excluded – we only want to re-run on track change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, tracks]);

  // ── Volume / mute ────────────────────────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = isMuted ? 0 : volume;
  }, [volume, isMuted]);

  // ── Cleanup on unmount ───────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  // ── Controls ─────────────────────────────────────────────────────────────
  const advanceTrack = useCallback(
    (delta: number) => {
      if (tracks.length === 0) return;
      setCurrentIndex((i) => (i + delta + tracks.length) % tracks.length);
    },
    [tracks.length]
  );

  const handlePlayPause = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      if (!audio.src && currentTrack) {
        audio.src = currentTrack.liveUrl;
        audio.load();
      }
      audio.play().catch(() => {});
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setCurrentTime(ratio * duration);
  };

  const handleSelectTrack = (index: number) => {
    setCurrentIndex(index);
    // Will auto-play via the track load effect + manual trigger
    setTimeout(() => {
      audioRef.current?.play().catch(() => {});
    }, 100);
  };

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  // ── Render helpers ───────────────────────────────────────────────────────
  const TrackSkeleton = () => (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <Skeleton className="w-8 h-8 rounded-lg bg-white/10" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-3/5 bg-white/10" />
        <Skeleton className="h-3 w-2/5 bg-white/10" />
      </div>
      <Skeleton className="h-3 w-8 bg-white/10" />
    </div>
  );

  return (
    <div className="min-h-screen gradient-bg text-white relative overflow-hidden">
      {/* Ambient glows */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 left-1/3 w-96 h-96 bg-purple-900/20 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/3 w-80 h-80 bg-violet-900/20 rounded-full blur-3xl" />
        <div className="absolute top-1/2 -left-20 w-64 h-64 bg-indigo-900/10 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 max-w-2xl mx-auto px-4 py-8 space-y-6">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header className="flex items-center justify-between fade-in-up">
          <div>
            <button
              onClick={() => navigate('/')}
              className="text-xs tracking-[0.25em] text-purple-400 uppercase font-semibold hover:text-purple-300 transition-colors flex items-center gap-1.5"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M15 18l-6-6 6-6" />
              </svg>
              PR Personal Radio
            </button>
            <h2 className="text-2xl font-bold mt-1 text-white">
              Hey, <span className="text-purple-300">{firstName}</span> 👋
            </h2>
          </div>

          <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-full px-4 py-2">
            {isBuffering ? (
              <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            ) : (
              <div className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-red-500 animate-pulse' : 'bg-white/30'}`} />
            )}
            <span className="text-xs font-semibold tracking-wider text-white/60">
              {isBuffering ? 'BUFFERING' : isPlaying ? 'LIVE' : 'PAUSED'}
            </span>
          </div>
        </header>

        {/* ── AI Greeting ─────────────────────────────────────────────────── */}
        <div className="fade-in-up-delay-1 glass-card rounded-2xl p-5">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-violet-600 to-purple-700 flex items-center justify-center flex-shrink-0 mt-0.5">
              <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2a5 5 0 1 1 0 10A5 5 0 0 1 12 2zm0 12c5.33 0 8 2.67 8 4v2H4v-2c0-1.33 2.67-4 8-4z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold text-purple-400 uppercase tracking-wider">AI Host</span>
                <span className="text-xs text-white/25">·</span>
                <span className="text-xs text-white/30 capitalize">{getTimeOfDay()} edition</span>
              </div>
              {isGreetingLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-3.5 w-full bg-white/10" />
                  <Skeleton className="h-3.5 w-4/5 bg-white/10" />
                  <Skeleton className="h-3.5 w-3/5 bg-white/10" />
                </div>
              ) : (
                <p className="text-white/80 text-sm leading-relaxed italic">"{greeting}"</p>
              )}
              {greetingNote && (
                <p className="text-xs text-white/25 mt-2 flex items-center gap-1">
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" /><path d="M12 8v4m0 4h.01" />
                  </svg>
                  {greetingNote}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ── Now Playing Player ──────────────────────────────────────────── */}
        <div className="fade-in-up-delay-2 glass-card rounded-3xl p-6">

          {/* Album art + track info */}
          <div className="flex items-center gap-5 mb-6">
            {/* Album art / vinyl */}
            <div className="relative flex-shrink-0">
              {tracksLoading || !currentTrack ? (
                <div className={`w-24 h-24 rounded-full bg-gray-800 border-4 border-gray-700 flex items-center justify-center ${isPlaying ? 'vinyl-spin' : ''}`}>
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-600 to-purple-800" />
                </div>
              ) : (
                <div className={`w-24 h-24 rounded-full overflow-hidden border-4 border-gray-700 shadow-2xl ${isPlaying ? 'vinyl-spin' : 'vinyl-spin paused'}`}>
                  <img
                    src={currentTrack.artworkUrl}
                    alt={currentTrack.albumTitle}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  {/* Center dot overlay */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-6 h-6 rounded-full bg-black/60 border-2 border-white/20" />
                  </div>
                </div>
              )}
              {isPlaying && !isBuffering && (
                <div className="absolute inset-0 rounded-full bg-purple-600/15 blur-xl animate-pulse pointer-events-none" />
              )}
            </div>

            {/* Track details */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-semibold text-purple-400 uppercase tracking-widest">Now Playing</span>
                {currentTrack && (
                  <a
                    href={`https://wavlake.com/track/${currentTrack.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open on Wavlake"
                    className="text-white/20 hover:text-purple-400 transition-colors"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                )}
              </div>

              {tracksLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-5 w-36 bg-white/10" />
                  <Skeleton className="h-3.5 w-24 bg-white/10" />
                  <Skeleton className="h-5 w-20 rounded-full bg-white/10 mt-2" />
                </div>
              ) : tracksError ? (
                <p className="text-red-400 text-sm">Couldn't load tracks — check connection</p>
              ) : currentTrack ? (
                <>
                  <h3 className="text-xl font-bold text-white truncate">{currentTrack.name}</h3>
                  <p className="text-white/60 text-sm mt-0.5 truncate">{currentTrack.artist}</p>
                  {currentTrack.albumTitle && (
                    <span className="inline-block mt-2 text-xs text-purple-300/70 bg-purple-900/30 border border-purple-700/30 rounded-full px-3 py-0.5 truncate max-w-full">
                      {currentTrack.albumTitle}
                    </span>
                  )}
                </>
              ) : null}
            </div>
          </div>

          {/* Waveform visualizer */}
          <div className="flex items-end justify-center gap-1 h-8 mb-5">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className={`w-1.5 rounded-full bg-gradient-to-t from-violet-600 to-purple-400 wave-bar ${(!isPlaying || isBuffering) ? 'paused' : ''}`}
                style={{ height: '4px' }}
              />
            ))}
          </div>

          {/* Progress bar */}
          <div className="mb-5">
            <div
              className="w-full h-1.5 bg-white/10 rounded-full cursor-pointer relative group"
              onClick={handleSeek}
            >
              <div
                className="h-full rounded-full progress-bar-inner transition-all duration-300 relative"
                style={{ width: `${progressPct}%` }}
              >
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white shadow-lg opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>
            <div className="flex justify-between mt-1.5 text-xs text-white/30">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration || (currentTrack?.duration ?? 0))}</span>
            </div>
          </div>

          {/* Controls row */}
          <div className="flex items-center justify-between">
            {/* Volume */}
            <div className="flex items-center gap-2 flex-1">
              <button
                onClick={() => setIsMuted((m) => !m)}
                className="text-white/40 hover:text-white/80 transition-colors"
                aria-label={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted || volume === 0 ? (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={isMuted ? 0 : volume}
                onChange={(e) => {
                  setVolume(Number(e.target.value));
                  setIsMuted(false);
                }}
                className="w-20 h-1"
                aria-label="Volume"
              />
            </div>

            {/* Playback buttons */}
            <div className="flex items-center gap-4">
              <button
                onClick={() => advanceTrack(-1)}
                disabled={tracksLoading || tracks.length === 0}
                className="w-10 h-10 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-all disabled:opacity-30"
                aria-label="Previous track"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
                </svg>
              </button>

              <button
                onClick={handlePlayPause}
                disabled={tracksLoading || tracks.length === 0}
                className="w-14 h-14 rounded-full bg-gradient-to-br from-violet-600 to-purple-700 flex items-center justify-center glow-purple hover:scale-105 active:scale-95 transition-all shadow-lg disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isBuffering ? (
                  <svg className="w-5 h-5 text-white animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                ) : isPlaying ? (
                  <svg className="w-6 h-6 text-white" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6 text-white ml-0.5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              <button
                onClick={() => advanceTrack(1)}
                disabled={tracksLoading || tracks.length === 0}
                className="w-10 h-10 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-all disabled:opacity-30"
                aria-label="Next track"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                </svg>
              </button>
            </div>

            {/* Wavlake attribution */}
            <div className="flex-1 flex justify-end">
              <a
                href="https://wavlake.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/20 hover:text-purple-400 transition-colors text-xs tracking-wide"
                title="Music powered by Wavlake"
              >
                ⚡ Wavlake
              </a>
            </div>
          </div>
        </div>

        {/* ── Coming Up ───────────────────────────────────────────────────── */}
        <div className="fade-in-up-delay-3 space-y-3">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-semibold text-white/60 uppercase tracking-widest">Coming Up</h3>
            <span className="text-xs text-purple-400">{UPCOMING_SEGMENTS.length} segments</span>
          </div>

          {UPCOMING_SEGMENTS.map((seg, i) => (
            <div
              key={i}
              className="glass-card rounded-2xl p-4 flex items-start gap-4 hover:border-purple-700/40 transition-all duration-200 group cursor-default"
            >
              <div className="w-11 h-11 rounded-xl bg-white/5 flex items-center justify-center flex-shrink-0 text-xl group-hover:bg-purple-900/40 transition-colors">
                {seg.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`text-xs font-bold uppercase tracking-wider ${seg.type === 'podcast' ? 'text-amber-400' : 'text-purple-400'}`}>
                    {seg.type === 'podcast' ? 'Podcast' : 'Music Set'}
                  </span>
                  <span className="text-xs text-white/25">·</span>
                  <span className="text-xs text-white/40">{seg.duration}</span>
                </div>
                <p className="text-sm font-semibold text-white truncate">{seg.title}</p>
                <p className="text-xs text-white/40 mt-0.5">{seg.host} · {seg.description}</p>
              </div>
            </div>
          ))}
        </div>

        {/* ── Playlist ────────────────────────────────────────────────────── */}
        <div className="fade-in-up-delay-3 space-y-3">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-semibold text-white/60 uppercase tracking-widest">Playlist</h3>
            <span className="text-xs text-purple-400">
              {tracksLoading ? '…' : `${tracks.length} tracks`}
            </span>
          </div>

          <div className="glass-card rounded-2xl overflow-hidden divide-y divide-white/5">
            {tracksLoading ? (
              Array.from({ length: 6 }).map((_, i) => <TrackSkeleton key={i} />)
            ) : tracksError ? (
              <div className="px-4 py-8 text-center">
                <p className="text-white/40 text-sm">Couldn't load playlist from Wavlake.</p>
                <p className="text-white/25 text-xs mt-1">Check your internet connection and try refreshing.</p>
              </div>
            ) : (
              tracks.map((track, i) => (
                <button
                  key={track.id}
                  onClick={() => handleSelectTrack(i)}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-white/5 transition-colors group ${
                    i === currentIndex ? 'bg-purple-900/20' : ''
                  }`}
                >
                  {/* Index / waveform indicator */}
                  <div className="w-8 flex items-center justify-center flex-shrink-0">
                    {i === currentIndex ? (
                      <div className="flex items-end gap-0.5 h-5">
                        {[1, 2, 3].map((b) => (
                          <div
                            key={b}
                            className={`w-1 rounded-full bg-purple-400 wave-bar ${(!isPlaying || isBuffering) ? 'paused' : ''}`}
                            style={{ height: '4px' }}
                          />
                        ))}
                      </div>
                    ) : (
                      <span className="text-white/30 text-sm group-hover:text-white/60">{i + 1}</span>
                    )}
                  </div>

                  {/* Artwork thumbnail */}
                  <div className="w-9 h-9 rounded-lg overflow-hidden flex-shrink-0 bg-white/5">
                    <img
                      src={track.artworkUrl}
                      alt={track.name}
                      className="w-full h-full object-cover"
                      loading="lazy"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${i === currentIndex ? 'text-purple-300' : 'text-white/80'}`}>
                      {track.name}
                    </p>
                    <p className="text-xs text-white/40 truncate">{track.artist}</p>
                  </div>

                  <span className="text-xs text-white/30 flex-shrink-0">
                    {formatTime(track.duration)}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <div className="text-center pt-2 pb-10 space-y-1.5">
          {!user && (
            <p className="text-white/20 text-xs">
              Log in with Nostr for AI-generated personalized greetings
            </p>
          )}
          <p className="text-white/20 text-xs">
            Music powered by{' '}
            <a href="https://wavlake.com" target="_blank" rel="noopener noreferrer" className="hover:text-purple-400 transition-colors">
              Wavlake ⚡
            </a>
            {' · '}
            <a href="https://shakespeare.diy" target="_blank" rel="noopener noreferrer" className="hover:text-purple-400 transition-colors">
              Vibed with Shakespeare
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
