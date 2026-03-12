import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useShakespeare } from '@/hooks/useShakespeare';
import { useCurrentUser } from '@/hooks/useCurrentUser';

// Placeholder playlist data
const PLAYLIST = [
  { title: 'Midnight Echoes', artist: 'Luna Waves', duration: '3:42', genre: 'Ambient Electronic' },
  { title: 'Golden Hour', artist: 'The Solar Ensemble', duration: '4:15', genre: 'Indie Folk' },
  { title: 'City Lights', artist: 'Neon Drift', duration: '3:58', genre: 'Synthwave' },
  { title: 'Quiet Storm', artist: 'Jade Rivers', duration: '5:01', genre: 'Neo-Soul' },
  { title: 'First Light', artist: 'Morning Atlas', duration: '3:29', genre: 'Lo-fi Beats' },
];

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

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getGreetingTime(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

export function RadioPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const name = searchParams.get('name') || 'Listener';
  const firstName = name.split(' ')[0];

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [totalSeconds, setTotalSeconds] = useState(222); // 3:42
  const [volume, setVolume] = useState(80);
  const [isMuted, setIsMuted] = useState(false);
  const [greeting, setGreeting] = useState('');
  const [isGreetingLoading, setIsGreetingLoading] = useState(false);
  const [greetingError, setGreetingError] = useState('');

  const progressInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const { sendChatMessage, isAuthenticated } = useShakespeare();
  const { user } = useCurrentUser();

  const currentTrack = PLAYLIST[currentTrackIndex];

  // Parse track duration into seconds
  const parseDuration = (dur: string): number => {
    const [m, s] = dur.split(':').map(Number);
    return m * 60 + s;
  };

  // Generate AI greeting
  const generateGreeting = useCallback(async () => {
    setIsGreetingLoading(true);
    setGreetingError('');
    try {
      const timeOfDay = getGreetingTime();
      const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      const response = await sendChatMessage([
        {
          role: 'system',
          content:
            'You are a warm, charismatic AI radio host for a premium personal radio station called PR – Personal Radio. Speak naturally, like a real radio host. Be brief (2-3 sentences max), uplifting, and personal. Do not use emojis.',
        },
        {
          role: 'user',
          content: `Generate a ${timeOfDay} greeting for a listener named ${name}. Today is ${today}. Make it feel warm and personal, like they just tuned in to their favorite station.`,
        },
      ]);
      const text = response.choices[0]?.message?.content;
      if (typeof text === 'string') {
        setGreeting(text);
      }
    } catch {
      // Fallback greeting
      const timeOfDay = getGreetingTime();
      setGreeting(
        `Good ${timeOfDay}, ${firstName}. Welcome back to PR – your personal station. We've got a great lineup queued up just for you today. Sit back, relax, and enjoy the music.`
      );
      setGreetingError('Using fallback greeting (log in with Nostr for AI-powered greetings)');
    } finally {
      setIsGreetingLoading(false);
    }
  }, [name, firstName, sendChatMessage]);

  useEffect(() => {
    generateGreeting();
  }, [generateGreeting]);

  // Simulate playback progress
  useEffect(() => {
    if (isPlaying) {
      progressInterval.current = setInterval(() => {
        setProgress((prev) => {
          if (prev >= totalSeconds) {
            // Auto-advance to next track
            setCurrentTrackIndex((i) => {
              const next = (i + 1) % PLAYLIST.length;
              setTotalSeconds(parseDuration(PLAYLIST[next].duration));
              return next;
            });
            return 0;
          }
          return prev + 1;
        });
      }, 1000);
    } else {
      if (progressInterval.current) clearInterval(progressInterval.current);
    }

    return () => {
      if (progressInterval.current) clearInterval(progressInterval.current);
    };
  }, [isPlaying, totalSeconds]);

  const handlePlayPause = () => setIsPlaying((p) => !p);

  const handlePrev = () => {
    const prev = (currentTrackIndex - 1 + PLAYLIST.length) % PLAYLIST.length;
    setCurrentTrackIndex(prev);
    setTotalSeconds(parseDuration(PLAYLIST[prev].duration));
    setProgress(0);
  };

  const handleNext = () => {
    const next = (currentTrackIndex + 1) % PLAYLIST.length;
    setCurrentTrackIndex(next);
    setTotalSeconds(parseDuration(PLAYLIST[next].duration));
    setProgress(0);
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    setProgress(Math.floor(ratio * totalSeconds));
  };

  const progressPercent = totalSeconds > 0 ? (progress / totalSeconds) * 100 : 0;

  return (
    <div className="min-h-screen gradient-bg text-white relative overflow-hidden">
      {/* Background ambient glows */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 left-1/3 w-96 h-96 bg-purple-900/20 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/3 w-80 h-80 bg-violet-900/20 rounded-full blur-3xl" />
        <div className="absolute top-1/2 -left-20 w-64 h-64 bg-indigo-900/10 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 max-w-2xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
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

          {/* Live indicator */}
          <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-full px-4 py-2">
            <div className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-red-500 animate-pulse' : 'bg-white/30'}`} />
            <span className="text-xs font-semibold tracking-wider text-white/60">
              {isPlaying ? 'LIVE' : 'PAUSED'}
            </span>
          </div>
        </header>

        {/* AI Greeting Card */}
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
                {!isAuthenticated && (
                  <span className="text-xs text-white/30">· Log in for personalized greetings</span>
                )}
              </div>
              {isGreetingLoading ? (
                <div className="space-y-2">
                  <div className="h-3.5 bg-white/10 rounded-full animate-pulse w-full" />
                  <div className="h-3.5 bg-white/10 rounded-full animate-pulse w-4/5" />
                  <div className="h-3.5 bg-white/10 rounded-full animate-pulse w-3/5" />
                </div>
              ) : (
                <p className="text-white/80 text-sm leading-relaxed italic">"{greeting}"</p>
              )}
              {greetingError && (
                <p className="text-xs text-white/30 mt-2">{greetingError}</p>
              )}
            </div>
          </div>
        </div>

        {/* Now Playing – Vinyl + Player */}
        <div className="fade-in-up-delay-2 glass-card rounded-3xl p-6">
          {/* Track Info + Vinyl */}
          <div className="flex items-center gap-6 mb-6">
            {/* Vinyl Record */}
            <div className="relative flex-shrink-0">
              <div className={`w-24 h-24 rounded-full bg-gradient-to-br from-gray-800 to-gray-900 border-4 border-gray-700 shadow-2xl flex items-center justify-center ${isPlaying ? 'vinyl-spin' : 'vinyl-spin paused'}`}>
                {/* Vinyl grooves */}
                <div className="absolute inset-3 rounded-full border border-white/5" />
                <div className="absolute inset-5 rounded-full border border-white/5" />
                <div className="absolute inset-7 rounded-full border border-white/5" />
                <div className="absolute inset-9 rounded-full border border-white/5" />
                {/* Center label */}
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-600 to-purple-800 flex items-center justify-center z-10">
                  <div className="w-2 h-2 rounded-full bg-white/60" />
                </div>
              </div>
              {/* Glow */}
              {isPlaying && (
                <div className="absolute inset-0 rounded-full bg-purple-600/20 blur-xl animate-pulse" />
              )}
            </div>

            {/* Track info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-semibold text-purple-400 uppercase tracking-widest">Now Playing</span>
              </div>
              <h3 className="text-xl font-bold text-white truncate">{currentTrack.title}</h3>
              <p className="text-white/60 text-sm mt-0.5">{currentTrack.artist}</p>
              <span className="inline-block mt-2 text-xs text-purple-300/70 bg-purple-900/30 border border-purple-700/30 rounded-full px-3 py-0.5">
                {currentTrack.genre}
              </span>
            </div>
          </div>

          {/* Waveform Visualizer */}
          <div className="flex items-end justify-center gap-1 h-8 mb-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className={`w-1.5 rounded-full bg-gradient-to-t from-violet-600 to-purple-400 wave-bar ${!isPlaying ? 'paused' : ''}`}
                style={{ height: '4px' }}
              />
            ))}
          </div>

          {/* Progress Bar */}
          <div className="mb-4">
            <div
              className="w-full h-1.5 bg-white/10 rounded-full cursor-pointer relative group"
              onClick={handleProgressClick}
            >
              <div
                className="h-full rounded-full progress-bar-inner transition-all duration-300 relative"
                style={{ width: `${progressPercent}%` }}
              >
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white shadow-lg opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>
            <div className="flex justify-between mt-2 text-xs text-white/30">
              <span>{formatTime(progress)}</span>
              <span>{currentTrack.duration}</span>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center justify-between">
            {/* Volume */}
            <div className="flex items-center gap-2 flex-1">
              <button
                onClick={() => setIsMuted((m) => !m)}
                className="text-white/40 hover:text-white/80 transition-colors"
              >
                {isMuted || volume === 0 ? (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
                  </svg>
                )}
              </button>
              <input
                type="range"
                min="0"
                max="100"
                value={isMuted ? 0 : volume}
                onChange={(e) => {
                  setVolume(Number(e.target.value));
                  setIsMuted(false);
                }}
                className="w-20 h-1"
              />
            </div>

            {/* Playback controls */}
            <div className="flex items-center gap-4">
              <button
                onClick={handlePrev}
                className="w-10 h-10 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-all"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
                </svg>
              </button>

              <button
                onClick={handlePlayPause}
                className="w-14 h-14 rounded-full bg-gradient-to-br from-violet-600 to-purple-700 flex items-center justify-center glow-purple hover:scale-105 active:scale-95 transition-all shadow-lg"
              >
                {isPlaying ? (
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
                onClick={handleNext}
                className="w-10 h-10 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-all"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                </svg>
              </button>
            </div>

            {/* Shuffle / spacer */}
            <div className="flex-1 flex justify-end">
              <button className="text-white/30 hover:text-purple-400 transition-colors">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Up Next – Queue */}
        <div className="fade-in-up-delay-3 space-y-3">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-semibold text-white/60 uppercase tracking-widest">Coming Up</h3>
            <span className="text-xs text-purple-400">{UPCOMING_SEGMENTS.length} segments</span>
          </div>

          {UPCOMING_SEGMENTS.map((seg, i) => (
            <div
              key={i}
              className="glass-card rounded-2xl p-4 flex items-start gap-4 hover:border-purple-700/40 transition-all duration-200 group cursor-pointer"
              style={{ animationDelay: `${0.3 + i * 0.1}s` }}
            >
              {/* Icon */}
              <div className="w-11 h-11 rounded-xl bg-white/5 flex items-center justify-center flex-shrink-0 text-xl group-hover:bg-purple-900/40 transition-colors">
                {seg.icon}
              </div>

              {/* Info */}
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

              {/* Arrow */}
              <div className="text-white/20 group-hover:text-purple-400 transition-colors flex-shrink-0 mt-1">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </div>
            </div>
          ))}
        </div>

        {/* Playlist */}
        <div className="fade-in-up-delay-3 space-y-3">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-sm font-semibold text-white/60 uppercase tracking-widest">Playlist</h3>
            <span className="text-xs text-purple-400">{PLAYLIST.length} tracks</span>
          </div>

          <div className="glass-card rounded-2xl overflow-hidden divide-y divide-white/5">
            {PLAYLIST.map((track, i) => (
              <button
                key={i}
                onClick={() => {
                  setCurrentTrackIndex(i);
                  setTotalSeconds(parseDuration(track.duration));
                  setProgress(0);
                  setIsPlaying(true);
                }}
                className={`w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-white/5 transition-colors group ${
                  i === currentTrackIndex ? 'bg-purple-900/20' : ''
                }`}
              >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0">
                  {i === currentTrackIndex ? (
                    <div className="flex items-end gap-0.5 h-5">
                      {[1, 2, 3].map((b) => (
                        <div
                          key={b}
                          className={`w-1 rounded-full bg-purple-400 wave-bar ${!isPlaying ? 'paused' : ''}`}
                          style={{ height: '4px' }}
                        />
                      ))}
                    </div>
                  ) : (
                    <span className="text-white/30 text-sm group-hover:text-white/60">{i + 1}</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate ${i === currentTrackIndex ? 'text-purple-300' : 'text-white/80'}`}>
                    {track.title}
                  </p>
                  <p className="text-xs text-white/40 truncate">{track.artist}</p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-xs text-white/30">{track.duration}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="text-center pt-4 pb-8">
          <p className="text-white/20 text-xs">
            <a href="https://shakespeare.diy" target="_blank" rel="noopener noreferrer" className="hover:text-purple-400 transition-colors">
              Vibed with Shakespeare
            </a>
          </p>
          {!user && (
            <p className="text-white/20 text-xs mt-1">
              Log in with Nostr to unlock AI-generated personalized greetings
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
