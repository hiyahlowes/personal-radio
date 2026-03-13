/**
 * SetupPage — 4-step onboarding flow
 *
 * Step 1: Language selection
 * Step 2: Name entry
 * Step 3: Genre selection (Wavlake genres)
 * Step 4: Podcast selection (PodcastIndex trending + search)
 *
 * On completion: saves language, name, genres, and podcast feeds to localStorage,
 * sets setupComplete = true, then navigates to /radio.
 *
 * All localStorage keys are shared with SettingsPage.
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { GENRES, ALL_GENRE_IDS, TOP_CHARTS_ID } from '@/hooks/useWavlakeTracks';
import {
  getStoredFeeds,
  setStoredFeeds,
  type PodcastFeed,
} from '@/hooks/usePodcastFeeds';
import {
  fetchTrendingPodcasts,
  searchPodcasts,
  type PodcastIndexFeed,
} from '@/hooks/usePodcastIndex';

// ── localStorage keys (shared with Settings) ──────────────────────────────────
export const SETUP_COMPLETE_KEY = 'pr:setupComplete';
export const LISTENER_NAME_KEY  = 'pr:listenerName';
export const GENRES_KEY         = 'pr:selected-genres';
export const LANGUAGE_KEY       = 'pr:language';

const LANGUAGES = [
  { value: 'English',  label: 'English',  flag: '🇬🇧' },
  { value: 'Deutsch',  label: 'Deutsch',  flag: '🇩🇪' },
  { value: 'Français', label: 'Français', flag: '🇫🇷' },
];

export function getStoredName(): string {
  return localStorage.getItem(LISTENER_NAME_KEY) ?? '';
}

export function setStoredName(name: string): void {
  localStorage.setItem(LISTENER_NAME_KEY, name);
}

// ── Component ─────────────────────────────────────────────────────────────────

const TOTAL_STEPS = 4;

export function SetupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);

  // Step 1 — language
  const [language, setLanguage] = useState(() => localStorage.getItem(LANGUAGE_KEY) || 'English');

  // Step 2 — pre-populate from localStorage if re-entering setup
  const [name, setName]         = useState(() => getStoredName());
  const [nameFocused, setNF]    = useState(false);

  // Step 3 — pre-populate genres if re-entering
  const [selectedGenres, setSelectedGenres] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(GENRES_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as string[];
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  });

  // Step 4 — pre-populate feeds if re-entering
  const [addedFeeds, setAddedFeeds] = useState<PodcastFeed[]>(() => getStoredFeeds());
  const [query, setQuery]           = useState('');
  const [trending, setTrending]     = useState<PodcastIndexFeed[]>([]);
  const [results, setResults]       = useState<PodcastIndexFeed[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError]     = useState('');
  const [addedIds, setAddedIds]           = useState<Set<number>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Fetch trending podcasts when reaching step 4 ──────────────────────────
  useEffect(() => {
    if (step !== 4) return;
    setSearchLoading(true);
    fetchTrendingPodcasts()
      .then(setTrending)
      .catch(err => setSearchError(String(err)))
      .finally(() => setSearchLoading(false));
  }, [step]);

  // ── Debounced podcast search ───────────────────────────────────────────────
  useEffect(() => {
    if (step !== 4) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearchLoading(true);
      setSearchError('');
      try {
        const res = await searchPodcasts(query);
        setResults(res);
      } catch (err) {
        setSearchError(String(err));
      } finally {
        setSearchLoading(false);
      }
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, step]);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const toggleGenre = (id: string) => {
    setSelectedGenres(prev => {
      if (id === TOP_CHARTS_ID) {
        // Exclusive toggle — clears genres when selected, falls back to empty when deselected
        return prev.includes(TOP_CHARTS_ID) ? [] : [TOP_CHARTS_ID];
      }
      // Any genre click exits Top Charts mode
      const withoutTop = prev.filter(g => g !== TOP_CHARTS_ID);
      return withoutTop.includes(id) ? withoutTop.filter(g => g !== id) : [...withoutTop, id];
    });
  };

  const isTopChartsSelected = selectedGenres.includes(TOP_CHARTS_ID);

  const addPodcast = (feed: PodcastIndexFeed) => {
    if (addedFeeds.find(f => f.url === feed.url)) return;
    setAddedFeeds(prev => [...prev, { url: feed.url, title: feed.title }]);
    setAddedIds(prev => new Set(prev).add(feed.id));
  };

  const removePodcast = (url: string) => {
    setAddedFeeds(prev => prev.filter(f => f.url !== url));
  };

  // ── Complete setup ─────────────────────────────────────────────────────────
  const finish = () => {
    const trimmedName = name.trim();

    // 1. Save language
    localStorage.setItem(LANGUAGE_KEY, language);

    // 2. Save listener name
    setStoredName(trimmedName);

    // 3. Save genres (use all if somehow empty — shouldn't happen via UI)
    const genresToSave = selectedGenres.length > 0 ? selectedGenres : ALL_GENRE_IDS;
    localStorage.setItem(GENRES_KEY, JSON.stringify(genresToSave));

    // 4. Save podcast feeds
    setStoredFeeds(addedFeeds);

    // 5. Mark setup complete
    localStorage.setItem(SETUP_COMPLETE_KEY, 'true');

    // 6. Navigate to radio
    navigate(`/radio?name=${encodeURIComponent(trimmedName)}`);
  };

  // ── Navigation guards ──────────────────────────────────────────────────────
  const canNext1 = true; // language always has a default
  const canNext2 = name.trim().length > 0;
  const canNext3 = selectedGenres.length > 0;
  const canFinish = addedFeeds.length > 0;

  const goNext = () => {
    if (step === 1) setStep(2);
    else if (step === 2 && canNext2) setStep(3);
    else if (step === 3 && canNext3) setStep(4);
    else if (step === 4 && canFinish) finish();
  };

  const goBack = () => {
    if (step > 1) setStep(step - 1);
  };

  // ── Displayed podcast list ─────────────────────────────────────────────────
  const displayList = query.trim() ? results : trending;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen gradient-bg text-white relative overflow-hidden">
      {/* Background glows */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-purple-700/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-violet-600/10 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-indigo-900/20 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 max-w-lg mx-auto px-4 py-10">

        {/* Logo */}
        <div className="flex items-center justify-center mb-8">
          <div className="relative">
            <div className="w-14 h-14 rounded-full bg-gradient-to-br from-violet-600 to-purple-800 flex items-center justify-center glow-purple">
              <svg className="w-7 h-7 text-white" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="3" fill="currentColor" />
                <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2z" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
                <path d="M8.464 8.464A5 5 0 0 0 7 12a5 5 0 0 0 5 5 5 5 0 0 0 5-5 5 5 0 0 0-1.464-3.536" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            {Array.from({ length: TOTAL_STEPS }).map((_, i) => {
              const s = i + 1;
              const done    = s < step;
              const current = s === step;
              return (
                <div key={s} className="flex items-center flex-1">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all duration-300
                    ${done    ? 'bg-purple-600 border-purple-600 text-white' :
                      current ? 'bg-transparent border-purple-500 text-purple-400' :
                                'bg-transparent border-white/15 text-white/25'}`}>
                    {done
                      ? <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                      : s
                    }
                  </div>
                  {s < TOTAL_STEPS && (
                    <div className={`flex-1 h-0.5 mx-1 rounded-full transition-all duration-500 ${done ? 'bg-purple-600' : 'bg-white/10'}`} />
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-white/30 text-right">Step {step} of {TOTAL_STEPS}</p>
        </div>

        {/* ── STEP 1: Language ────────────────────────────────────────────── */}
        {step === 1 && (
          <div className="fade-in-up space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-3xl font-black tracking-tight">Welcome to PR</h1>
              <p className="text-lg font-light text-purple-300">Personal Radio</p>
              <p className="text-white/50 text-sm leading-relaxed mt-3">
                Choose the language your AI host will speak.
              </p>
            </div>

            <div className="glass-card rounded-2xl p-6 space-y-3">
              <p className="text-sm font-semibold text-white/70">Host language</p>
              {LANGUAGES.map(lang => {
                const active = language === lang.value;
                return (
                  <button
                    key={lang.value}
                    onClick={() => setLanguage(lang.value)}
                    aria-pressed={active}
                    className={`w-full flex items-center gap-4 px-5 py-4 rounded-xl border-2 transition-all duration-150 text-left
                      ${active
                        ? 'bg-purple-600/25 border-purple-500/70 text-white shadow-sm shadow-purple-900/40'
                        : 'bg-white/5 border-white/10 text-white/50 hover:border-white/25 hover:text-white/70 hover:bg-white/8'
                      }`}
                  >
                    <span className="text-2xl select-none">{lang.flag}</span>
                    <span className="text-base font-semibold">{lang.label}</span>
                    {active && (
                      <svg className="w-4 h-4 ml-auto text-purple-400 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── STEP 2: Name ────────────────────────────────────────────────── */}
        {step === 2 && (
          <div className="fade-in-up space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-3xl font-black tracking-tight">What's your name?</h1>
              <p className="text-white/50 text-sm leading-relaxed mt-3">
                Your AI host will greet you by name and curate the perfect mix of music and podcasts.
              </p>
            </div>

            <div className="glass-card rounded-2xl p-6 space-y-4">
              <label className="block text-sm font-semibold text-white/70">Your name</label>
              <div className="relative">
                <div className={`absolute inset-0 rounded-xl transition-all duration-300 ${nameFocused ? 'bg-gradient-to-r from-violet-600/20 to-purple-600/20 blur-sm scale-105' : 'bg-transparent'}`} />
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onFocus={() => setNF(true)}
                  onBlur={() => setNF(false)}
                  onKeyDown={e => e.key === 'Enter' && canNext2 && goNext()}
                  placeholder="e.g. Alex"
                  maxLength={50}
                  autoFocus
                  className={`relative w-full px-5 py-3.5 text-lg font-medium text-white placeholder-white/25 bg-white/5 border-2 rounded-xl outline-none transition-all duration-300 ${nameFocused ? 'border-purple-500 bg-white/8' : 'border-white/10 hover:border-white/20'}`}
                />
              </div>
              <p className="text-xs text-white/30">Your AI host will use this to greet you every time you tune in.</p>
            </div>
          </div>
        )}

        {/* ── STEP 3: Genres ──────────────────────────────────────────────── */}
        {step === 3 && (
          <div className="fade-in-up space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-3xl font-black tracking-tight">What do you want to hear?</h1>
              <p className="text-white/50 text-sm leading-relaxed mt-3">
                Pick the genres you're in the mood for. You can always change this later.
              </p>
            </div>

            <div className="glass-card rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-white/70">Music genres</p>
                {selectedGenres.length > 0 && (
                  <button
                    onClick={() => setSelectedGenres([])}
                    className="text-xs text-white/30 hover:text-white/50 transition-colors"
                  >
                    Clear all
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                {/* ⚡ Top Charts — spans full width, always first */}
                <button
                  onClick={() => toggleGenre(TOP_CHARTS_ID)}
                  aria-pressed={isTopChartsSelected}
                  className={`col-span-2 flex items-center gap-3 px-4 py-3.5 rounded-xl border-2 transition-all duration-150 text-left
                    ${isTopChartsSelected
                      ? 'bg-amber-500/20 border-amber-400/70 text-white shadow-sm shadow-amber-900/40'
                      : 'bg-white/5 border-white/10 text-white/50 hover:border-amber-500/40 hover:text-amber-200/80 hover:bg-amber-900/10'
                    }`}
                >
                  <span className="text-xl select-none">⚡</span>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-semibold block">Top Charts</span>
                    <span className="text-xs text-white/40">Wavlake Top 40 — ranked by Lightning tips</span>
                  </div>
                  {isTopChartsSelected && (
                    <svg className="w-4 h-4 ml-auto text-amber-400 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                    </svg>
                  )}
                </button>

                {/* Standard genre cards */}
                {GENRES.map(genre => {
                  const active = !isTopChartsSelected && selectedGenres.includes(genre.id);
                  const emoji = genreEmoji[genre.id] ?? '🎵';
                  return (
                    <button
                      key={genre.id}
                      onClick={() => toggleGenre(genre.id)}
                      aria-pressed={active}
                      className={`flex items-center gap-3 px-4 py-3.5 rounded-xl border-2 transition-all duration-150 text-left
                        ${active
                          ? 'bg-purple-600/25 border-purple-500/70 text-white shadow-sm shadow-purple-900/40'
                          : 'bg-white/5 border-white/10 text-white/50 hover:border-white/25 hover:text-white/70 hover:bg-white/8'
                        } ${isTopChartsSelected ? 'opacity-40' : ''}`}
                    >
                      <span className="text-xl select-none">{emoji}</span>
                      <span className="text-sm font-semibold">{genre.label}</span>
                      {active && (
                        <svg className="w-4 h-4 ml-auto text-purple-400 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>

              {selectedGenres.length === 0 && (
                <p className="text-xs text-amber-400/80 bg-amber-900/20 border border-amber-700/30 rounded-lg px-3 py-2 text-center">
                  Select Top Charts or at least one genre to continue
                </p>
              )}
              {isTopChartsSelected && (
                <p className="text-xs text-amber-300/70 text-center">
                  ⚡ Top 40 — listener-ranked hits on Wavlake
                </p>
              )}
              {!isTopChartsSelected && selectedGenres.length > 0 && (
                <p className="text-xs text-purple-300/70 text-center">
                  {selectedGenres.length} genre{selectedGenres.length !== 1 ? 's' : ''} selected
                </p>
              )}
            </div>
          </div>
        )}

        {/* ── STEP 4: Podcasts ────────────────────────────────────────────── */}
        {step === 4 && (
          <div className="fade-in-up space-y-5">
            <div className="text-center space-y-2">
              <h1 className="text-3xl font-black tracking-tight">Add a podcast or two</h1>
              <p className="text-white/50 text-sm leading-relaxed mt-3">
                Your AI host will weave podcast segments between tracks. Pick at least one to get started.
              </p>
            </div>

            {/* Added feeds list */}
            {addedFeeds.length > 0 && (
              <div className="glass-card rounded-2xl overflow-hidden divide-y divide-white/5">
                {addedFeeds.map(feed => (
                  <div key={feed.url} className="flex items-center gap-3 px-4 py-3.5 group">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0">
                      <svg className="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6.18 15.64a2.18 2.18 0 0 1 2.18 2.18C8.36 19.01 7.38 20 6.18 20C4.98 20 4 19.01 4 17.82a2.18 2.18 0 0 1 2.18-2.18M4 4.44A15.56 15.56 0 0 1 19.56 20h-2.83A12.73 12.73 0 0 0 4 7.27V4.44m0 5.66a9.9 9.9 0 0 1 9.9 9.9h-2.83A7.07 7.07 0 0 0 4 12.93V10.1z"/>
                      </svg>
                    </div>
                    <p className="text-sm font-semibold text-white flex-1 truncate">{feed.title}</p>
                    <button
                      onClick={() => removePodcast(feed.url)}
                      className="w-7 h-7 rounded-lg flex items-center justify-center text-white/20 hover:text-red-400 hover:bg-red-400/10 transition-all opacity-0 group-hover:opacity-100"
                      aria-label={`Remove ${feed.title}`}
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Search + trending */}
            <div className="glass-card rounded-2xl p-5 space-y-4">
              {/* Search input */}
              <div className="relative">
                <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <input
                  type="search"
                  value={query}
                  onChange={e => { setQuery(e.target.value); setSearchError(''); }}
                  placeholder="Search podcasts…"
                  className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder-white/25 outline-none focus:border-purple-500 transition-colors"
                />
              </div>

              {/* Section label */}
              <p className="text-xs font-semibold text-white/50 uppercase tracking-widest">
                {query.trim()
                  ? searchLoading ? 'Searching…' : `${results.length} result${results.length !== 1 ? 's' : ''}`
                  : 'Trending 🔥'}
              </p>

              {searchError && <p className="text-xs text-red-400">{searchError}</p>}

              {/* Skeleton */}
              {searchLoading && (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3 animate-pulse">
                      <div className="w-12 h-12 rounded-xl bg-white/10 flex-shrink-0" />
                      <div className="flex-1 space-y-2">
                        <div className="h-3 bg-white/10 rounded w-3/5" />
                        <div className="h-2.5 bg-white/10 rounded w-2/5" />
                      </div>
                      <div className="w-16 h-7 bg-white/10 rounded-lg" />
                    </div>
                  ))}
                </div>
              )}

              {/* Results */}
              {!searchLoading && (
                <div className="space-y-2">
                  {displayList.map(feed => {
                    const alreadyAdded = addedIds.has(feed.id) || !!addedFeeds.find(f => f.url === feed.url);
                    return (
                      <div key={feed.id} className="flex items-center gap-3 p-2 rounded-xl hover:bg-white/5 transition-colors">
                        {feed.artwork ? (
                          <img src={feed.artwork} alt={feed.title} className="w-12 h-12 rounded-xl object-cover flex-shrink-0 bg-white/10" onError={e => (e.currentTarget.style.display = 'none')} />
                        ) : (
                          <div className="w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0 text-xl">🎙️</div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-white truncate">{feed.title}</p>
                          {feed.author && <p className="text-xs text-white/40 truncate">{feed.author}</p>}
                        </div>
                        <button
                          onClick={() => addPodcast(feed)}
                          disabled={alreadyAdded}
                          className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                            alreadyAdded
                              ? 'bg-green-500/15 text-green-400 border border-green-500/30 cursor-default'
                              : 'bg-purple-600/20 text-purple-300 border border-purple-500/30 hover:bg-purple-600/40 hover:text-white'
                          }`}
                        >
                          {alreadyAdded ? '✓ Added' : '+ Add'}
                        </button>
                      </div>
                    );
                  })}

                  {!searchLoading && query.trim() && results.length === 0 && !searchError && (
                    <p className="text-sm text-white/30 text-center py-4">No results found.</p>
                  )}
                </div>
              )}
            </div>

            {addedFeeds.length === 0 && (
              <p className="text-xs text-amber-400/80 bg-amber-900/20 border border-amber-700/30 rounded-lg px-3 py-2 text-center">
                Add at least one podcast to continue
              </p>
            )}
          </div>
        )}

        {/* ── Navigation buttons ───────────────────────────────────────────── */}
        <div className="mt-8 flex items-center gap-3">
          {step > 1 && (
            <button
              onClick={goBack}
              className="flex-shrink-0 w-11 h-11 rounded-full flex items-center justify-center text-white/40 hover:text-white/70 hover:bg-white/10 border border-white/10 transition-all"
              aria-label="Back"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M15 18l-6-6 6-6"/>
              </svg>
            </button>
          )}

          <button
            onClick={goNext}
            disabled={
              (step === 2 && !canNext2) ||
              (step === 3 && !canNext3) ||
              (step === 4 && !canFinish)
            }
            className={`flex-1 py-3.5 text-base font-bold rounded-2xl transition-all duration-300 ${
              step === 1 ||
              (step === 2 && canNext2) ||
              (step === 3 && canNext3) ||
              (step === 4 && canFinish)
                ? 'bg-gradient-to-r from-violet-600 to-purple-600 text-white hover:from-violet-500 hover:to-purple-500 glow-purple-sm hover:scale-[1.01] active:scale-[0.99]'
                : 'bg-white/5 text-white/25 cursor-not-allowed border border-white/10'
            }`}
          >
            {step === 1 && 'Continue →'}
            {step === 2 && (canNext2 ? `Continue, ${name.trim().split(' ')[0]} →` : 'Enter your name to continue')}
            {step === 3 && (canNext3 ? 'Continue →' : 'Select at least one genre')}
            {step === 4 && (canFinish ? '🎙️ Start listening →' : 'Add at least one podcast')}
          </button>
        </div>

        {/* Footer */}
        <p className="mt-10 text-center text-white/15 text-xs">
          <a href="https://shakespeare.diy" target="_blank" rel="noopener noreferrer" className="hover:text-purple-400 transition-colors">
            Vibed with Shakespeare
          </a>
        </p>
      </div>
    </div>
  );
}

// ── Genre emoji map ───────────────────────────────────────────────────────────
const genreEmoji: Record<string, string> = {
  ambient:    '🌊',
  electronic: '⚡',
  lofi:       '☕',
  rock:       '🎸',
  folk:       '🪕',
  jazz:       '🎷',
  classical:  '🎻',
  hiphop:     '🎤',
};
