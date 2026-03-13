/**
 * usePodcastIndex
 *
 * Thin wrapper around the PodcastIndex REST API.
 * Auth: SHA-1(apiKey + apiSecret + unixTimestamp) per PodcastIndex spec.
 *
 * Credentials are read from environment variables:
 *   VITE_PODCASTINDEX_API_KEY
 *   VITE_PODCASTINDEX_API_SECRET
 *
 * If either is missing the functions return empty arrays and log a warning,
 * so the app still loads without crashing.
 */

const BASE_URL = 'https://api.podcastindex.org/api/1.0';

// ── Credentials ───────────────────────────────────────────────────────────────
const PI_API_KEY    = import.meta.env.VITE_PODCASTINDEX_API_KEY    as string | undefined;
const PI_API_SECRET = import.meta.env.VITE_PODCASTINDEX_API_SECRET as string | undefined;

const credentialsAvailable = Boolean(PI_API_KEY && PI_API_SECRET);

if (!credentialsAvailable) {
  console.warn(
    '[PodcastIndex] VITE_PODCASTINDEX_API_KEY / VITE_PODCASTINDEX_API_SECRET not set. ' +
    'Podcast search and trending will be unavailable.',
  );
}

export interface PodcastIndexFeed {
  id: number;
  title: string;
  url: string;       // RSS feed URL to add
  artwork: string;   // cover art image URL
  author: string;
  description: string;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function sha1Hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function buildHeaders(): Promise<Record<string, string>> {
  // Caller must check credentialsAvailable before calling this
  const apiKey    = PI_API_KEY!;
  const apiSecret = PI_API_SECRET!;
  const timestamp = Math.floor(Date.now() / 1000);
  const hash      = await sha1Hex(apiKey + apiSecret + timestamp);

  return {
    'X-Auth-Key':    apiKey,
    'X-Auth-Date':   String(timestamp),
    'Authorization': hash,
    'User-Agent':    'PersonalRadio/1.0',
  };
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function fetchTrendingPodcasts(): Promise<PodcastIndexFeed[]> {
  if (!credentialsAvailable) return [];
  const headers = await buildHeaders();
  const res = await fetch(
    `${BASE_URL}/podcasts/trending?max=3&lang=en&cat=&notcat=`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`PodcastIndex trending ${res.status}`);
  const data = await res.json();
  return (data?.feeds ?? []) as PodcastIndexFeed[];
}

export async function searchPodcasts(query: string): Promise<PodcastIndexFeed[]> {
  if (!credentialsAvailable) return [];
  if (!query.trim()) return [];
  const headers = await buildHeaders();
  const res = await fetch(
    `${BASE_URL}/search/byterm?q=${encodeURIComponent(query.trim())}&max=5`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`PodcastIndex search ${res.status}`);
  const data = await res.json();
  return (data?.feeds ?? []) as PodcastIndexFeed[];
}
