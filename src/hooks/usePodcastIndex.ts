/**
 * usePodcastIndex
 *
 * Fetches podcast data from PodcastIndex via a Netlify Function proxy that
 * keeps API credentials server-side and eliminates CORS issues.
 *
 * All environments (production and local dev via Netlify CLI) use:
 *   /.netlify/functions/podcast-proxy?action=...
 *
 * Netlify env vars (server-side only, no VITE_ prefix):
 *   PODCASTINDEX_API_KEY
 *   PODCASTINDEX_API_SECRET
 */

const PROXY_BASE_URL = '/.netlify/functions/podcast-proxy';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PodcastIndexFeed {
  id: number;
  title: string;
  url: string;       // RSS feed URL
  artwork: string;   // cover art image URL
  author: string;
  description: string;
  /** PodcastIndex sets this to 1 when the feed has podcast:transcript tags. */
  hasTranscripts?: number;
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function fetchTrendingPodcasts(): Promise<PodcastIndexFeed[]> {
  const res = await fetch(
    `${PROXY_BASE_URL}?action=trending`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`PodcastIndex trending ${res.status}`);
  const data = await res.json();
  return (data?.feeds ?? []) as PodcastIndexFeed[];
}

export async function searchPodcasts(query: string, max = 10): Promise<PodcastIndexFeed[]> {
  if (!query.trim()) return [];
  const res = await fetch(
    `${PROXY_BASE_URL}?action=search&q=${encodeURIComponent(query.trim())}&max=${max}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`PodcastIndex search ${res.status}`);
  const data = await res.json();
  return (data?.feeds ?? []) as PodcastIndexFeed[];
}

// ── Curated transcript-first suggestions ──────────────────────────────────────
// These are well-known Bitcoin / tech / Podcast 2.0 shows that are known to
// publish podcast:transcript tags, giving the best AI-host commentary experience.
// We search PodcastIndex by exact show name, take the top hit from each query,
// merge + deduplicate, and sort transcript-supporting feeds to the top.

const SUGGESTED_QUERIES = [
  'TFTC Tales from the Crypt',
  'What Bitcoin Did',
  'Coin Stories',
  'Bitcoin Audible',
  'THE Bitcoin Podcast',
  'Citadel Dispatch',
  'Bitcoin Magazine Podcast',
  'Stephan Livera Podcast',
];

export async function fetchSuggestedPodcasts(): Promise<PodcastIndexFeed[]> {
  // Fan out — fetch top 3 from each query in parallel
  const settled = await Promise.allSettled(
    SUGGESTED_QUERIES.map(q => searchPodcasts(q, 3)),
  );

  const seen = new Set<number>();
  const all: PodcastIndexFeed[] = [];

  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const feed of result.value) {
      if (!seen.has(feed.id)) {
        seen.add(feed.id);
        all.push(feed);
      }
    }
  }

  // Sort: transcript-supporting feeds first, then rest
  return all.sort((a, b) => (b.hasTranscripts ?? 0) - (a.hasTranscripts ?? 0));
}
