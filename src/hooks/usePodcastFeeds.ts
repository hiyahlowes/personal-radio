import { useQuery } from '@tanstack/react-query';

// ── CORS proxy cascade ────────────────────────────────────────────────────────
// Tried in order; first response that parses as real RSS/Atom wins.
const FETCH_TIMEOUT_MS = 15_000;

interface ProxyStrategy {
  name: string;
  buildUrl: (feedUrl: string) => string;
}

const PROXY_STRATEGIES: ProxyStrategy[] = [
  {
    name: 'corsproxy.io',
    buildUrl: (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  },
  {
    name: 'codetabs',
    buildUrl: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  },
  {
    name: 'direct',
    buildUrl: (url) => url,
  },
];

/** Attempt a single fetch with a hard timeout; throws on non-OK or timeout. */
async function attemptFetch(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Fetch raw RSS/XML for `feedUrl`, trying each proxy strategy in sequence.
 * Returns the raw text from the first strategy that returns valid RSS/Atom XML.
 *
 * Sanity check: the response body must contain an <rss or <feed root element —
 * this rejects HTML pages (e.g. Squarespace homepages) that proxies sometimes
 * return with HTTP 200 when they follow redirects to the wrong URL.
 */
async function fetchRawFeed(feedUrl: string): Promise<string> {
  const errors: string[] = [];

  for (const strategy of PROXY_STRATEGIES) {
    const proxyUrl = strategy.buildUrl(feedUrl);
    try {
      console.log(`[Podcast] trying ${strategy.name} for ${feedUrl}`);
      const text = await attemptFetch(proxyUrl);

      // Must look like RSS or Atom — reject HTML pages silently returned as 200
      const trimmed = text.trim();
      const isRss  = trimmed.includes('<rss') || trimmed.includes('<feed') || trimmed.includes('<channel');
      if (!isRss) {
        throw new Error('Response is not RSS/Atom XML');
      }

      console.log(`[Podcast] ✓ ${strategy.name} succeeded for ${feedUrl}`);
      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Podcast] ✗ ${strategy.name} failed for ${feedUrl}: ${msg}`);
      errors.push(`${strategy.name}: ${msg}`);
    }
  }

  throw new Error(`All strategies failed for ${feedUrl} — ${errors.join(' | ')}`);
}

export interface PodcastEpisode {
  id: string;           // guid or generated
  feedTitle: string;    // podcast show name
  title: string;        // episode title
  audioUrl: string;
  duration: number;     // seconds (0 if not parseable)
  description: string;
  pubDate: string;
}

export interface PodcastFeed {
  url: string;
  title: string;
}

// ── Verified working feed URLs (tested 2026-03-12) ───────────────────────────
// All four original URLs were dead:
//   - whatbitcoindid.com/feed        → Squarespace homepage HTML (200 OK, but no RSS)
//   - feeds.fountain.fm/...          → "Object Not Found"
//   - secularbuddhism.com/feed/...   → server unreachable
//   - feeds.simplecast.com/pZrFHAMR → S3 404 NoSuchKey
//
// Replaced with confirmed live Libsyn / Megaphone feeds:
export const DEFAULT_FEEDS: PodcastFeed[] = [
  {
    url: 'https://whatbitcoindid.libsyn.com/rss',
    title: 'What Bitcoin Did',
  },
  {
    url: 'https://feeds.megaphone.fm/hubermanlab',
    title: 'Huberman Lab',
  },
  {
    url: 'https://feeds.megaphone.fm/WWO3519750118',
    title: 'The Dan Bongino Show',
  },
  {
    url: 'https://feeds.megaphone.fm/TBIEA4386204774',
    title: 'Tech Won\'t Save Us',
  },
];

const FEEDS_STORAGE_KEY = 'pr:podcast-feeds';

export function getStoredFeeds(): PodcastFeed[] {
  try {
    const raw = localStorage.getItem(FEEDS_STORAGE_KEY);
    if (!raw) return DEFAULT_FEEDS;
    const parsed = JSON.parse(raw) as PodcastFeed[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_FEEDS;
  } catch {
    return DEFAULT_FEEDS;
  }
}

export function setStoredFeeds(feeds: PodcastFeed[]): void {
  localStorage.setItem(FEEDS_STORAGE_KEY, JSON.stringify(feeds));
}

// ── RSS parsing ──────────────────────────────────────────────────────────────

/** Parse iTunes duration string (hh:mm:ss or mm:ss or plain seconds) → seconds */
function parseDuration(raw: string | null | undefined): number {
  if (!raw) return 0;
  const parts = raw.trim().split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  const n = Number(raw.trim());
  return isNaN(n) ? 0 : n;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getText(el: Element | null, tag: string): string {
  return el?.querySelector(tag)?.textContent?.trim() ?? '';
}

/**
 * Get text content of a potentially namespace-prefixed element.
 *
 * DOMParser with 'application/xml' preserves XML namespaces, so
 * `querySelector('itunes:duration')` is treated as a CSS selector with a
 * pseudo-element, not a namespace-prefixed tag, and silently returns null.
 *
 * We work around this by trying both forms:
 *   1. getElementsByTagNameNS with the iTunes namespace URI
 *   2. getElementsByTagName with the prefixed name (works in most browsers)
 *   3. Plain querySelector fallback (for non-namespaced or lenient parsers)
 */
const ITUNES_NS = 'http://www.itunes.com/dtds/podcast-1.0.dtd';

function getItunesText(item: Element, localName: string): string {
  // 1. Proper namespace lookup
  const byNS = item.getElementsByTagNameNS(ITUNES_NS, localName);
  if (byNS.length > 0) return byNS[0].textContent?.trim() ?? '';

  // 2. Prefixed tag name (Firefox / Chromium usually handle this)
  const byPrefixed = item.getElementsByTagName(`itunes:${localName}`);
  if (byPrefixed.length > 0) return byPrefixed[0].textContent?.trim() ?? '';

  // 3. Plain local name fallback
  const byLocal = item.getElementsByTagName(localName);
  if (byLocal.length > 0) return byLocal[0].textContent?.trim() ?? '';

  return '';
}

async function fetchFeed(feedUrl: string): Promise<PodcastEpisode[]> {
  const text   = await fetchRawFeed(feedUrl);
  const parser = new DOMParser();
  const doc    = parser.parseFromString(text, 'application/xml');

  // Detect parse errors (DOMParser never throws; it returns an <parsererror> doc)
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) {
    throw new Error(`XML parse error: ${parseErr.textContent?.slice(0, 120)}`);
  }

  // Get podcast title from channel
  const feedTitle =
    doc.querySelector('channel > title')?.textContent?.trim() ??
    doc.querySelector('feed > title')?.textContent?.trim() ??
    'Unknown Podcast';

  const items = Array.from(doc.querySelectorAll('item'));
  console.log(`[Podcast] "${feedTitle}" — ${items.length} items found`);

  const episodes: PodcastEpisode[] = [];

  for (const item of items.slice(0, 5)) { // take 5 most recent per feed
    // Audio URL — prefer enclosure url attribute, fall back to media:content
    const enclosure = item.querySelector('enclosure');
    const audioUrl  =
      enclosure?.getAttribute('url') ??
      item.querySelector('content')?.getAttribute('url') ??
      '';

    if (!audioUrl || !audioUrl.match(/\.(mp3|m4a|ogg|aac|wav)/i)) {
      console.log(`[Podcast] skipping item — no valid audio URL (got: "${audioUrl.slice(0, 60)}")`);
      continue;
    }

    const guid  = getText(item, 'guid') || `${feedUrl}-${episodes.length}`;
    const title = stripHtml(getText(item, 'title')) || 'Untitled Episode';

    const description = stripHtml(
      getText(item, 'description') ||
      getItunesText(item, 'summary') ||
      getItunesText(item, 'subtitle') ||
      ''
    ).slice(0, 200);

    // Duration — use proper namespace-aware lookup for itunes:duration
    const duration = parseDuration(getItunesText(item, 'duration'));

    const pubDate = getText(item, 'pubDate') || getText(item, 'published') || '';

    episodes.push({ id: guid, feedTitle, title, audioUrl, duration, description, pubDate });
  }

  console.log(`[Podcast] "${feedTitle}" — ${episodes.length} episodes parsed`);
  return episodes;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function usePodcastEpisodes(feeds: PodcastFeed[]) {
  return useQuery({
    queryKey: ['podcast-episodes', feeds.map(f => f.url).join(',')],
    queryFn: async (): Promise<PodcastEpisode[]> => {
      const results = await Promise.allSettled(feeds.map(f => fetchFeed(f.url)));
      const all: PodcastEpisode[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') all.push(...r.value);
        else console.warn('[Podcast] feed failed:', r.reason);
      }
      console.log(`[Podcast] total episodes loaded: ${all.length}`);
      // Shuffle so episodes from different feeds are interleaved
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      return all;
    },
    staleTime: 1000 * 60 * 30, // 30 min
    retry: 1,
  });
}
