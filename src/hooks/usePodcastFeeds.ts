import { useQuery } from '@tanstack/react-query';

// ── RSS fetch via Netlify Function proxy ──────────────────────────────────────
// All RSS fetching goes through /.netlify/functions/podcast-proxy?action=rss&url=...
// This avoids CORS issues on production and works locally via `netlify dev`.

const RSS_PROXY_URL = '/.netlify/functions/podcast-proxy';

/**
 * Fetch raw RSS/XML for `feedUrl` via the server-side Netlify Function proxy.
 * Throws if the response is not valid RSS/Atom XML.
 */
async function fetchRawFeed(feedUrl: string): Promise<string> {
  const proxyUrl = `${RSS_PROXY_URL}?action=rss&url=${encodeURIComponent(feedUrl)}`;
  console.log(`[Podcast] fetching via proxy: ${feedUrl}`);

  const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Proxy returned HTTP ${res.status}: ${body.slice(0, 120)}`);
  }

  const text = await res.text();

  // Sanity-check: must look like RSS or Atom XML
  const trimmed = text.trim();
  const isRss = trimmed.includes('<rss') || trimmed.includes('<feed') || trimmed.includes('<channel');
  if (!isRss) {
    throw new Error('Response is not RSS/Atom XML');
  }

  console.log(`[Podcast] ✓ proxy succeeded for ${feedUrl}`);
  return text;
}

export interface PodcastChapter {
  startTime: number; // seconds
  title: string;
}

export interface PodcastEpisode {
  id: string;           // guid or generated
  feedTitle: string;    // podcast show name
  title: string;        // episode title
  audioUrl: string;
  duration: number;     // seconds (0 if not parseable)
  description: string;
  pubDate: string;
  chapters?: PodcastChapter[]; // Podcast 2.0 chapter markers, if available
}

export interface PodcastFeed {
  url: string;
  title: string;
}

// No hardcoded default feeds — user sets their own during onboarding (SetupPage).
// An empty array is the correct default; onboarding enforces at least 1 feed.
export const DEFAULT_FEEDS: PodcastFeed[] = [];

const FEEDS_STORAGE_KEY = 'pr:podcast-feeds';

export function getStoredFeeds(): PodcastFeed[] {
  try {
    const raw = localStorage.getItem(FEEDS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PodcastFeed[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
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

// ── Podcast 2.0 chapters ─────────────────────────────────────────────────────

const PODCAST_NS = 'https://podcastindex.org/namespace/1.0';

function getPodcastChaptersUrl(item: Element): string | null {
  const byNS = item.getElementsByTagNameNS(PODCAST_NS, 'chapters');
  if (byNS.length > 0) return byNS[0].getAttribute('url');

  const byPrefixed = item.getElementsByTagName('podcast:chapters');
  if (byPrefixed.length > 0) return byPrefixed[0].getAttribute('url');

  return null;
}

async function fetchChapters(chaptersUrl: string): Promise<PodcastChapter[]> {
  try {
    const res = await fetch(chaptersUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.chapters)) return [];
    return (data.chapters as Record<string, unknown>[])
      .filter(c => typeof c?.startTime === 'number')
      .map(c => ({ startTime: c.startTime as number, title: String(c.title ?? '') }));
  } catch (err) {
    console.warn('[Podcast] Failed to fetch chapters:', err);
    return [];
  }
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

    // Podcast 2.0 chapters
    let chapters: PodcastChapter[] | undefined;
    const chaptersUrl = getPodcastChaptersUrl(item);
    if (chaptersUrl) {
      const fetched = await fetchChapters(chaptersUrl);
      if (fetched.length > 0) {
        chapters = fetched;
        console.log(`[Podcast] "${title}" — ${chapters.length} chapters loaded`);
      }
    }

    episodes.push({ id: guid, feedTitle, title, audioUrl, duration, description, pubDate, chapters });
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
