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

export async function searchPodcasts(query: string): Promise<PodcastIndexFeed[]> {
  if (!query.trim()) return [];
  const res = await fetch(
    `${PROXY_BASE_URL}?action=search&q=${encodeURIComponent(query.trim())}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`PodcastIndex search ${res.status}`);
  const data = await res.json();
  return (data?.feeds ?? []) as PodcastIndexFeed[];
}
