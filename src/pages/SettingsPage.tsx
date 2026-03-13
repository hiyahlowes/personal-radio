import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSeoMeta } from '@unhead/react';
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
import { GENRES, ALL_GENRE_IDS, TOP_CHARTS_ID } from '@/hooks/useWavlakeTracks';
import { useLikedTracks } from '@/hooks/useLikedTracks';
import {
  getStoredName,
  setStoredName,
  GENRES_KEY,
} from '@/pages/SetupPage';

// Emoji map (shared style with SetupPage)
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

function loadStoredGenres(): string[] {
  try {
    const raw = localStorage.getItem(GENRES_KEY);
    if (!raw) return ALL_GENRE_IDS;
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : ALL_GENRE_IDS;
  } catch {
    return ALL_GENRE_IDS;
  }
}

export function SettingsPage() {
  useSeoMeta({ title: 'Settings — PR Personal Radio' });
  const navigate = useNavigate();

  // ── Listener name ─────────────────────────────────────────────────────────
  const [listenerName, setListenerName] = useState(getStoredName);
  const [nameSaved, setNameSaved]       = useState(false);

  const saveName = () => {
    setStoredName(listenerName.trim());
    setNameSaved(true);
    setTimeout(() => setNameSaved(false), 2000);
  };

  // ── Genre selection ───────────────────────────────────────────────────────
  const [selectedGenres, setSelectedGenres] = useState<string[]>(loadStoredGenres);
  const [genresSaved, setGenresSaved]       = useState(false);

  const toggleGenre = (id: string) => {
    setSelectedGenres(prev => {
      let next: string[];
      if (id === TOP_CHARTS_ID) {
        // Exclusive: selecting Top Charts clears genres, deselecting restores all
        next = prev.includes(TOP_CHARTS_ID) ? ALL_GENRE_IDS : [TOP_CHARTS_ID];
      } else {
        // Any genre click exits Top Charts mode
        const withoutTop = prev.filter(g => g !== TOP_CHARTS_ID);
        if (withoutTop.includes(id)) {
          if (withoutTop.length === 1) return prev; // don't deselect the last genre
          next = withoutTop.filter(g => g !== id);
        } else {
          next = [...withoutTop, id];
        }
      }
      localStorage.setItem(GENRES_KEY, JSON.stringify(next));
      setGenresSaved(true);
      setTimeout(() => setGenresSaved(false), 1500);
      return next;
    });
  };

  const isTopChartsSelected = selectedGenres.includes(TOP_CHARTS_ID);

  const selectAllGenres = () => {
    setSelectedGenres(ALL_GENRE_IDS);
    localStorage.setItem(GENRES_KEY, JSON.stringify(ALL_GENRE_IDS));
    setGenresSaved(true);
    setTimeout(() => setGenresSaved(false), 1500);
  };

  // ── Podcast feeds ─────────────────────────────────────────────────────────
  const [feeds, setFeeds]   = useState<PodcastFeed[]>(getStoredFeeds);
  const [error, setError]   = useState('');
  const [feedSaved, setFeedSaved] = useState(false);

  // ── Podcast search / trending ─────────────────────────────────────────────
  const [query, setQuery]               = useState('');
  const [trending, setTrending]         = useState<PodcastIndexFeed[]>([]);
  const [results, setResults]           = useState<PodcastIndexFeed[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError]     = useState('');
  const [addedIds, setAddedIds]           = useState<Set<number>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch trending on mount
  useEffect(() => {
    setSearchLoading(true);
    fetchTrendingPodcasts()
      .then(setTrending)
      .catch(err => setSearchError(String(err)))
      .finally(() => setSearchLoading(false));
  }, []);

  // Debounced search — or revert to trending when query is cleared
  useEffect(() => {
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
  }, [query]);

  const saveFeeds = (next: PodcastFeed[]) => {
    setFeeds(next);
    setStoredFeeds(next);
    setFeedSaved(true);
    setTimeout(() => setFeedSaved(false), 2000);
    // Notify RadioPage to refresh its podcast query
    window.dispatchEvent(new Event('pr:feeds-updated'));
  };

  const addFeedByUrl = (url: string, title: string) => {
    setError('');
    if (!url.startsWith('http')) { setError('URL must start with http:// or https://'); return; }
    if (feeds.find(f => f.url === url)) { setError('That feed is already in your list.'); return; }
    saveFeeds([...feeds, { url, title: title || new URL(url).hostname }]);
  };

  const addFromIndex = (feed: PodcastIndexFeed) => {
    if (feeds.find(f => f.url === feed.url)) return;
    saveFeeds([...feeds, { url: feed.url, title: feed.title }]);
    setAddedIds(prev => new Set(prev).add(feed.id));
  };

  const removeFeed = (url: string) => saveFeeds(feeds.filter(f => f.url !== url));

  // ── Liked tracks ───────────────────────────────────────────────────────────
  const { liked, unlike } = useLikedTracks();

  return (
    <div className="min-h-screen gradient-bg text-white">
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">

        {/* Header */}
        <header className="flex items-center gap-4 fade-in-up">
          <button
            onClick={() => navigate(-1)}
            className="w-9 h-9 rounded-full flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-all"
            aria-label="Go back"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M15 18l-6-6 6-6"/>
            </svg>
          </button>
          <div>
            <p className="text-xs tracking-[0.25em] text-purple-400 uppercase font-semibold">PR Personal Radio</p>
            <h1 className="text-2xl font-bold">Settings</h1>
          </div>
        </header>

        {/* ── Listener name ──────────────────────────────────────────────── */}
        <section className="fade-in-up space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold">Your name</h2>
              <p className="text-sm text-white/40 mt-0.5">How your AI host greets you</p>
            </div>
            {nameSaved && (
              <span className="text-xs text-green-400 font-semibold flex items-center gap-1">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                Saved
              </span>
            )}
          </div>
          <div className="glass-card rounded-2xl p-5 flex items-center gap-3">
            <input
              type="text"
              value={listenerName}
              onChange={e => setListenerName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && listenerName.trim() && saveName()}
              placeholder="Your name…"
              maxLength={50}
              className="flex-1 px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder-white/25 outline-none focus:border-purple-500 transition-colors"
            />
            <button
              onClick={saveName}
              disabled={!listenerName.trim()}
              className="px-4 py-2.5 bg-purple-600/20 text-purple-300 border border-purple-500/30 rounded-xl text-sm font-semibold hover:bg-purple-600/40 hover:text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Save
            </button>
          </div>
        </section>

        {/* ── Genre selection ────────────────────────────────────────────── */}
        <section className="fade-in-up-delay-1 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold">Music genres</h2>
              <p className="text-sm text-white/40 mt-0.5">Filter the Wavlake tracks in your stream</p>
            </div>
            <div className="flex items-center gap-3">
              {genresSaved && (
                <span className="text-xs text-green-400 font-semibold flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                  Saved
                </span>
              )}
              {!isTopChartsSelected && selectedGenres.length !== ALL_GENRE_IDS.length && (
                <button
                  onClick={selectAllGenres}
                  className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
                >
                  All
                </button>
              )}
            </div>
          </div>

          <div className="glass-card rounded-2xl p-4">
            <div className="flex flex-wrap gap-2">
              {/* ⚡ Top Charts — shown first, exclusive mode */}
              <button
                onClick={() => toggleGenre(TOP_CHARTS_ID)}
                aria-pressed={isTopChartsSelected}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-xl border transition-all duration-150 text-sm font-semibold select-none
                  ${isTopChartsSelected
                    ? 'bg-amber-500/20 border-amber-400/60 text-amber-200 shadow-sm shadow-amber-900/40'
                    : 'bg-white/5 border-white/10 text-white/40 hover:border-amber-500/40 hover:text-amber-300/70'
                  }`}
              >
                <span>⚡</span>
                Top Charts
              </button>

              {/* Standard genres */}
              {GENRES.map(genre => {
                const active = !isTopChartsSelected && selectedGenres.includes(genre.id);
                return (
                  <button
                    key={genre.id}
                    onClick={() => toggleGenre(genre.id)}
                    aria-pressed={active}
                    className={`flex items-center gap-2 px-3.5 py-2 rounded-xl border transition-all duration-150 text-sm font-semibold select-none
                      ${active
                        ? 'bg-purple-600/25 border-purple-500/60 text-purple-200 shadow-sm shadow-purple-900/40'
                        : 'bg-white/5 border-white/10 text-white/40 hover:border-white/25 hover:text-white/60'
                      } ${isTopChartsSelected ? 'opacity-40' : ''}`}
                  >
                    <span>{genreEmoji[genre.id] ?? '🎵'}</span>
                    {genre.label}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* ── Podcast feeds ──────────────────────────────────────────────── */}
        <section className="fade-in-up-delay-1 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold">Podcast Feeds</h2>
              <p className="text-sm text-white/40 mt-0.5">RSS feeds mixed into your radio stream</p>
            </div>
            {feedSaved && (
              <span className="text-xs text-green-400 font-semibold flex items-center gap-1">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                Saved
              </span>
            )}
          </div>

          {/* Feed list */}
          <div className="glass-card rounded-2xl overflow-hidden divide-y divide-white/5">
            {feeds.length === 0 ? (
              <div className="px-5 py-8 text-center">
                <p className="text-white/40 text-sm">No feeds yet. Add one below.</p>
              </div>
            ) : feeds.map(feed => (
              <div key={feed.url} className="flex items-start gap-3 px-5 py-4 group">
                <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <svg className="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6.18 15.64a2.18 2.18 0 0 1 2.18 2.18C8.36 19.01 7.38 20 6.18 20C4.98 20 4 19.01 4 17.82a2.18 2.18 0 0 1 2.18-2.18M4 4.44A15.56 15.56 0 0 1 19.56 20h-2.83A12.73 12.73 0 0 0 4 7.27V4.44m0 5.66a9.9 9.9 0 0 1 9.9 9.9h-2.83A7.07 7.07 0 0 0 4 12.93V10.1z"/>
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{feed.title}</p>
                  <p className="text-xs text-white/30 truncate mt-0.5">{feed.url}</p>
                </div>
                <button
                  onClick={() => removeFeed(feed.url)}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-white/20 hover:text-red-400 hover:bg-red-400/10 transition-all opacity-0 group-hover:opacity-100 flex-shrink-0"
                  aria-label={`Remove ${feed.title}`}
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                  </svg>
                </button>
              </div>
            ))}
          </div>

          {/* Search / trending panel */}
          <div className="glass-card rounded-2xl p-5 space-y-4">
            {/* Search input */}
            <div className="relative">
              <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <input
                type="search"
                value={query}
                onChange={e => { setQuery(e.target.value); setError(''); }}
                placeholder="Search podcasts…"
                className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder-white/25 outline-none focus:border-purple-500 transition-colors"
              />
            </div>

            {/* Section label */}
            <p className="text-xs font-semibold text-white/50 uppercase tracking-widest">
              {query.trim()
                ? searchLoading ? 'Searching…' : `${results.length} result${results.length !== 1 ? 's' : ''}`
                : 'Trending on Podcast Index 🔥'}
            </p>

            {/* Error */}
            {searchError && (
              <p className="text-xs text-red-400">{searchError}</p>
            )}

            {/* Skeleton cards while loading */}
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

            {/* Result / trending cards */}
            {!searchLoading && (
              <div className="space-y-2">
                {(query.trim() ? results : trending).map(feed => {
                  const alreadyAdded = addedIds.has(feed.id) || !!feeds.find(f => f.url === feed.url);
                  return (
                    <div key={feed.id} className="flex items-center gap-3 p-2 rounded-xl hover:bg-white/5 transition-colors group">
                      {/* Cover art */}
                      {feed.artwork ? (
                        <img
                          src={feed.artwork}
                          alt={feed.title}
                          className="w-12 h-12 rounded-xl object-cover flex-shrink-0 bg-white/10"
                          onError={e => (e.currentTarget.style.display = 'none')}
                        />
                      ) : (
                        <div className="w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0 text-xl">🎙️</div>
                      )}
                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-white truncate">{feed.title}</p>
                        {feed.author && <p className="text-xs text-white/40 truncate">{feed.author}</p>}
                      </div>
                      {/* Add button */}
                      <button
                        onClick={() => addFromIndex(feed)}
                        disabled={alreadyAdded}
                        className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                          alreadyAdded
                            ? 'bg-green-500/15 text-green-400 border border-green-500/30 cursor-default'
                            : 'bg-purple-600/20 text-purple-300 border border-purple-500/30 hover:bg-purple-600/40 hover:text-white'
                        }`}
                      >
                        {alreadyAdded ? '✓ Added' : 'Add'}
                      </button>
                    </div>
                  );
                })}

                {/* Empty states */}
                {!searchLoading && query.trim() && results.length === 0 && !searchError && (
                  <p className="text-sm text-white/30 text-center py-4">No results found.</p>
                )}
              </div>
            )}

            {/* Divider + paste URL manually */}
            <div className="pt-2 border-t border-white/5">
              <PasteUrlForm feeds={feeds} onAdd={addFeedByUrl} error={error} setError={setError} />
            </div>
          </div>
        </section>

        {/* ── Liked Tracks ────────────────────────────────────────────────── */}
        <section className="fade-in-up-delay-2 space-y-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold text-white/60 uppercase tracking-widest">♥ Liked Tracks</h2>
            {liked.length > 0 && (
              <span className="text-xs text-pink-400/70">{liked.length} track{liked.length !== 1 ? 's' : ''} · 2× priority</span>
            )}
          </div>
          {liked.length === 0 ? (
            <div className="glass-card rounded-2xl px-5 py-8 text-center">
              <p className="text-sm text-white/30">No liked tracks yet.</p>
              <p className="text-xs text-white/20 mt-1">Tap ♥ on any track while listening to save it here.</p>
            </div>
          ) : (
            <div className="glass-card rounded-2xl divide-y divide-white/5">
              {liked.map(track => (
                <div key={track.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-9 h-9 rounded-lg overflow-hidden flex-shrink-0 bg-white/5">
                    <img src={track.artworkUrl} alt={track.name} className="w-full h-full object-cover" loading="lazy" onError={e => (e.currentTarget.style.display = 'none')} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white/80 truncate">{track.name}</p>
                    <p className="text-xs text-white/40 truncate">{track.artist}</p>
                  </div>
                  <a
                    href={`https://wavlake.com/track/${track.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-shrink-0 text-white/20 hover:text-purple-400 transition-colors p-1"
                    aria-label="Open on Wavlake"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                  </a>
                  <button
                    onClick={() => unlike(track.id)}
                    aria-label="Unlike track"
                    className="flex-shrink-0 p-1.5 rounded-full text-pink-400 hover:text-red-400 hover:bg-red-900/20 transition-colors"
                  >
                    <svg className="w-4 h-4 fill-pink-400" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Re-run setup ───────────────────────────────────────────────── */}
        <section className="fade-in-up-delay-2">
          <div className="glass-card rounded-2xl p-5 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-white">Start over</p>
              <p className="text-xs text-white/40 mt-0.5">Re-run the setup wizard from the beginning</p>
            </div>
            <button
              onClick={() => {
                localStorage.removeItem('pr:setupComplete');
                navigate('/setup');
              }}
              className="flex-shrink-0 px-4 py-2 rounded-xl text-sm font-semibold text-white/60 border border-white/15 hover:border-white/30 hover:text-white/80 transition-all"
            >
              Setup wizard
            </button>
          </div>
        </section>

        {/* Footer */}
        <div className="text-center pt-4 pb-10">
          <p className="text-white/20 text-xs">
            <a href="https://shakespeare.diy" target="_blank" rel="noopener noreferrer" className="hover:text-purple-400 transition-colors">
              Vibed with Shakespeare
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Paste URL directly (collapsible) ─────────────────────────────────────────

function PasteUrlForm({
  feeds,
  onAdd,
  error,
  setError,
}: {
  feeds: PodcastFeed[];
  onAdd: (url: string, title: string) => void;
  error: string;
  setError: (e: string) => void;
}) {
  const [open, setOpen]   = useState(false);
  const [url, setUrl]     = useState('');
  const [title, setTitle] = useState('');

  const submit = () => {
    const trimmed = url.trim();
    if (!trimmed) { setError('Paste a feed URL first.'); return; }
    onAdd(trimmed, title.trim());
    setUrl('');
    setTitle('');
    setOpen(false);
  };

  // feeds is used by the parent — keep it in the dependency but suppress lint
  void feeds;

  return (
    <div className="space-y-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-white/30 hover:text-white/50 transition-colors"
      >
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6"/></svg>
        Paste RSS URL directly
      </button>
      {open && (
        <div className="space-y-2 pt-1">
          <input
            type="url"
            value={url}
            onChange={e => { setUrl(e.target.value); setError(''); }}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="https://example.com/feed.rss"
            className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder-white/25 outline-none focus:border-purple-500 transition-colors"
          />
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="Show name (optional)"
            className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder-white/25 outline-none focus:border-purple-500 transition-colors"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            onClick={submit}
            className="w-full py-2.5 bg-gradient-to-r from-violet-600 to-purple-600 text-white text-sm font-semibold rounded-xl hover:from-violet-500 hover:to-purple-500 transition-all"
          >
            Add Feed
          </button>
        </div>
      )}
    </div>
  );
}
