import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSeoMeta } from '@unhead/react';
import {
  DEFAULT_FEEDS,
  getStoredFeeds,
  setStoredFeeds,
  type PodcastFeed,
} from '@/hooks/usePodcastFeeds';
import {
  fetchTrendingPodcasts,
  searchPodcasts,
  type PodcastIndexFeed,
} from '@/hooks/usePodcastIndex';

export function SettingsPage() {
  useSeoMeta({ title: 'Settings — PR Personal Radio' });
  const navigate = useNavigate();

  const [feeds, setFeeds]   = useState<PodcastFeed[]>(getStoredFeeds);
  const [error, setError]   = useState('');
  const [saved, setSaved]   = useState(false);

  // ── Podcast search / trending ────────────────────────────────────────────
  const [query, setQuery]           = useState('');
  const [trending, setTrending]     = useState<PodcastIndexFeed[]>([]);
  const [results, setResults]       = useState<PodcastIndexFeed[]>([]);
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

  const save = (next: PodcastFeed[]) => {
    setFeeds(next);
    setStoredFeeds(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const addFeedByUrl = (url: string, title: string) => {
    setError('');
    if (!url.startsWith('http')) { setError('URL must start with http:// or https://'); return; }
    if (feeds.find(f => f.url === url)) { setError('That feed is already in your list.'); return; }
    save([...feeds, { url, title: title || new URL(url).hostname }]);
  };

  const addFromIndex = (feed: PodcastIndexFeed) => {
    if (feeds.find(f => f.url === feed.url)) return;
    save([...feeds, { url: feed.url, title: feed.title }]);
    setAddedIds(prev => new Set(prev).add(feed.id));
  };

  const removeFeed = (url: string) => save(feeds.filter(f => f.url !== url));

  const resetToDefaults = () => save([...DEFAULT_FEEDS]);

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

        {/* Podcast feeds */}
        <section className="fade-in-up-delay-1 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold">Podcast Feeds</h2>
              <p className="text-sm text-white/40 mt-0.5">RSS feeds mixed into your radio stream</p>
            </div>
            {saved && (
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
                        {alreadyAdded ? '✓ Added' : 'Add to session'}
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

          {/* Reset */}
          <button
            onClick={resetToDefaults}
            className="text-xs text-white/25 hover:text-white/50 transition-colors"
          >
            Reset to default feeds
          </button>
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
