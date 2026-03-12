import { useQuery } from '@tanstack/react-query';

const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

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

export const DEFAULT_FEEDS: PodcastFeed[] = [
  { url: 'https://www.whatbitcoindid.com/feed',                   title: 'What Bitcoin Did' },
  { url: 'https://feeds.fountain.fm/this-week-in-bitcoin',        title: 'This Week in Bitcoin' },
  { url: 'https://secularbuddhism.com/feed/podcast/',             title: 'Secular Buddhism' },
  { url: 'https://feeds.simplecast.com/pZrFHAMR',                 title: 'A Bit of Optimism' },
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

async function fetchFeed(feedUrl: string): Promise<PodcastEpisode[]> {
  const url     = `${CORS_PROXY}${encodeURIComponent(feedUrl)}`;
  const res     = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);
  const text    = await res.text();
  const parser  = new DOMParser();
  const doc     = parser.parseFromString(text, 'application/xml');

  // Get podcast title from channel
  const feedTitle =
    doc.querySelector('channel > title')?.textContent?.trim() ??
    doc.querySelector('feed > title')?.textContent?.trim() ??
    'Unknown Podcast';

  const items = Array.from(doc.querySelectorAll('item'));
  const episodes: PodcastEpisode[] = [];

  for (const item of items.slice(0, 5)) { // take 5 most recent per feed
    // Audio URL — prefer enclosure, fall back to media:content
    const enclosure = item.querySelector('enclosure');
    const audioUrl  =
      enclosure?.getAttribute('url') ??
      item.querySelector('content')?.getAttribute('url') ??
      '';
    if (!audioUrl || !audioUrl.match(/\.(mp3|m4a|ogg|aac|wav)/i)) continue;

    const guid        = getText(item, 'guid') || `${feedUrl}-${episodes.length}`;
    const title       = stripHtml(getText(item, 'title')) || 'Untitled Episode';
    const description = stripHtml(
      getText(item, 'description') ||
      getText(item, 'summary') ||
      getText(item, 'subtitle') ||
      ''
    ).slice(0, 200);

    // Duration — try itunes:duration, then enclosure length (bytes, not useful)
    const itunesDur = item.querySelector('duration')?.textContent?.trim();
    const duration  = parseDuration(itunesDur);

    const pubDate = getText(item, 'pubDate') || getText(item, 'published') || '';

    episodes.push({ id: guid, feedTitle, title, audioUrl, duration, description, pubDate });
  }

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
