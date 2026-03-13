/**
 * usePodcastIndex
 *
 * Fetches podcast data from PodcastIndex via a Netlify Function proxy that
 * keeps API credentials server-side and eliminates CORS issues on production.
 *
 * Routing:
 *   Production (Netlify)  → /.netlify/functions/podcast-proxy?action=...
 *   Local dev             → direct PodcastIndex API with VITE_ credentials
 *                           (functions aren't running locally by default)
 *
 * Netlify env vars (no VITE_ prefix — server-side only):
 *   PODCASTINDEX_API_KEY
 *   PODCASTINDEX_API_SECRET
 *
 * Local dev env vars (in .env.local):
 *   VITE_PODCASTINDEX_API_KEY
 *   VITE_PODCASTINDEX_API_SECRET
 */

const BASE_URL       = 'https://api.podcastindex.org/api/1.0';
const PROXY_BASE_URL = '/.netlify/functions/podcast-proxy';

// ── Environment detection ─────────────────────────────────────────────────────

/** True when running on Netlify (or any host where the function is available). */
function isProduction(): boolean {
  // On Netlify, VITE_NETLIFY is injected automatically, or we detect by hostname
  if (typeof window !== 'undefined') {
    const { hostname } = window.location;
    // localhost / 127.0.0.1 / local dev preview → use direct API
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.local')) {
      return false;
    }
  }
  return true;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PodcastIndexFeed {
  id: number;
  title: string;
  url: string;       // RSS feed URL
  artwork: string;   // cover art image URL
  author: string;
  description: string;
}

// ── Local dev: direct API with VITE_ credentials ──────────────────────────────

const PI_API_KEY    = import.meta.env.VITE_PODCASTINDEX_API_KEY    as string | undefined;
const PI_API_SECRET = import.meta.env.VITE_PODCASTINDEX_API_SECRET as string | undefined;

async function sha1Hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function buildDirectHeaders(): Promise<Record<string, string>> {
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
  let res: Response;

  if (isProduction()) {
    // Use the Netlify Function proxy — no credentials needed client-side
    res = await fetch(
      `${PROXY_BASE_URL}?action=trending`,
      { signal: AbortSignal.timeout(10_000) },
    );
  } else {
    // Local dev: call PodcastIndex directly with VITE_ credentials
    if (!PI_API_KEY || !PI_API_SECRET) {
      console.warn('[PodcastIndex] No VITE_ credentials — trending unavailable in dev');
      return [];
    }
    const headers = await buildDirectHeaders();
    res = await fetch(
      `${BASE_URL}/podcasts/trending?max=10&lang=en&cat=&notcat=`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
  }

  if (!res.ok) throw new Error(`PodcastIndex trending ${res.status}`);
  const data = await res.json();
  return (data?.feeds ?? []) as PodcastIndexFeed[];
}

export async function searchPodcasts(query: string): Promise<PodcastIndexFeed[]> {
  if (!query.trim()) return [];

  let res: Response;

  if (isProduction()) {
    res = await fetch(
      `${PROXY_BASE_URL}?action=search&q=${encodeURIComponent(query.trim())}`,
      { signal: AbortSignal.timeout(10_000) },
    );
  } else {
    if (!PI_API_KEY || !PI_API_SECRET) {
      console.warn('[PodcastIndex] No VITE_ credentials — search unavailable in dev');
      return [];
    }
    const headers = await buildDirectHeaders();
    res = await fetch(
      `${BASE_URL}/search/byterm?q=${encodeURIComponent(query.trim())}&max=10`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
  }

  if (!res.ok) throw new Error(`PodcastIndex search ${res.status}`);
  const data = await res.json();
  return (data?.feeds ?? []) as PodcastIndexFeed[];
}
