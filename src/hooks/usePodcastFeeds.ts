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
  author: string;       // itunes:author or feed-level author
  pubDate: string;
  chapters?: PodcastChapter[];     // Podcast 2.0 chapter markers, if available
  transcriptUrl?: string;          // Podcast 2.0 transcript URL, if available
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

// ── Enclosure type-preference selection ──────────────────────────────────────
// Podcast feeds sometimes include multiple <enclosure> tags (e.g. audio/mpeg
// AND video/mp4). We prefer audio types so iOS never receives a video/mp4
// container it cannot decode.

function enclosureTypeRank(type: string): number {
  const t = type.toLowerCase();
  if (t === 'audio/mpeg' || t === 'audio/mp3')  return 0; // best
  if (t === 'audio/x-m4a')                       return 1;
  if (t.startsWith('audio/'))                    return 2;
  return 3; // video/mp4 or unknown — last resort
}

interface EnclosureCandidate { url: string; type: string; rank: number }

/**
 * From all <enclosure> (and <content>) elements on a feed item, pick the
 * best audio URL by MIME-type preference:
 *   1. audio/mpeg | audio/mp3
 *   2. audio/x-m4a
 *   3. any other audio/* type
 *   4. anything else (video/mp4, no type, …)
 *
 * If the top-ranked URL still contains '.mp4' in the path AND a non-mp4
 * audio alternative exists, the alternative is used instead.
 */
function getEnclosureAudioUrl(item: Element): { url: string; type: string } | null {
  const candidates: EnclosureCandidate[] = [
    ...Array.from(item.querySelectorAll('enclosure')),
    ...Array.from(item.querySelectorAll('content')),
  ]
    .map(el => ({
      url:  el.getAttribute('url')  ?? '',
      type: el.getAttribute('type') ?? '',
      rank: enclosureTypeRank(el.getAttribute('type') ?? ''),
    }))
    .filter(c => c.url.length > 0);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.rank - b.rank);
  let best = candidates[0];

  // If best URL contains '.mp4' in the path but an audio alternative exists,
  // prefer the audio one to avoid NotSupportedError on iOS.
  if (best.url.includes('.mp4')) {
    const audioAlt = candidates.find(c => !c.url.includes('.mp4') && c.rank < 3);
    if (audioAlt) best = audioAlt;
  }

  return { url: best.url, type: best.type };
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

/**
 * Return the best available `podcast:transcript` URL from a feed item.
 * Prefers structured formats (JSON → SRT → VTT → plain text) over unknown types.
 */
function getPodcastTranscriptUrl(item: Element): string | null {
  const all = [
    ...Array.from(item.getElementsByTagNameNS(PODCAST_NS, 'transcript')),
    ...Array.from(item.getElementsByTagName('podcast:transcript')),
  ];
  if (all.length === 0) return null;

  const PREFERRED = [
    'application/json',
    'application/x-subrip',
    'text/vtt',
    'text/plain',
  ];
  for (const type of PREFERRED) {
    const match = all.find(el => el.getAttribute('type') === type);
    if (match) return match.getAttribute('url');
  }
  return all[0].getAttribute('url');
}

async function fetchChapters(chaptersUrl: string): Promise<PodcastChapter[]> {
  try {
    const proxyUrl = `${RSS_PROXY_URL}?action=json&url=${encodeURIComponent(chaptersUrl)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10_000) });
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

  // Get podcast title and feed-level author from channel
  const feedTitle =
    doc.querySelector('channel > title')?.textContent?.trim() ??
    doc.querySelector('feed > title')?.textContent?.trim() ??
    'Unknown Podcast';

  const feedAuthor = (() => {
    const ch = doc.querySelector('channel');
    if (!ch) return '';
    return getItunesText(ch, 'author') ||
      ch.querySelector('author name')?.textContent?.trim() ||
      ch.querySelector('managingEditor')?.textContent?.trim() ||
      '';
  })();

  const allItems = Array.from(doc.querySelectorAll('item'));
  console.log(`[Podcast] "${feedTitle}" — ${allItems.length} items found`);

  // Sort by pubDate descending so the newest episode is always first,
  // regardless of the order the feed delivers items.
  const items = allItems.sort((a, b) => {
    const dateA = new Date(getText(a, 'pubDate') || getText(a, 'published') || 0).getTime();
    const dateB = new Date(getText(b, 'pubDate') || getText(b, 'published') || 0).getTime();
    return dateB - dateA; // descending — newest first
  });

  const episodes: PodcastEpisode[] = [];

  for (const item of items.slice(0, 5)) { // take 5 most recent per feed
    // Audio URL — pick best enclosure by MIME-type preference.
    // Prefers audio/mpeg over video/mp4 so iOS never receives an undecodable container.
    const enc      = getEnclosureAudioUrl(item);
    const audioUrl = enc?.url  ?? '';
    const encType  = enc?.type ?? '';

    const isAudioByType = encType.startsWith('audio/') || encType.startsWith('video/');
    const isAudioByUrl  = /\.(mp3|m4a|ogg|aac|wav|mp4)/i.test(audioUrl);
    if (!audioUrl || (!isAudioByType && !isAudioByUrl)) {
      console.log(`[Podcast] skipping item — no valid audio URL (got: "${audioUrl.slice(0, 60)}")`);
      continue;
    }
    console.log(`[Podcast] enclosure selected: ${encType || 'unknown'} — ${audioUrl.slice(0, 80)}`);

    const guid  = getText(item, 'guid') || `${feedUrl}-${episodes.length}`;
    const title = stripHtml(getText(item, 'title')) || 'Untitled Episode';

    const description = stripHtml(
      getText(item, 'description') ||
      getItunesText(item, 'summary') ||
      getItunesText(item, 'subtitle') ||
      ''
    ).slice(0, 200);

    const author = getItunesText(item, 'author') || feedAuthor;

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

    // Podcast 2.0 transcript URL (best available format)
    const transcriptUrl = getPodcastTranscriptUrl(item) ?? undefined;
    if (transcriptUrl) console.log(`[Podcast] "${title}" — transcript URL: ${transcriptUrl.slice(0, 80)}`);

    episodes.push({ id: guid, feedTitle, title, audioUrl, duration, description, author, pubDate, chapters, transcriptUrl });
  }

  console.log(`[Podcast] "${feedTitle}" — ${episodes.length} episodes parsed`);
  return episodes;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Fetch episodes for a single podcast feed URL.
 * Used by the episode management panel to show all available episodes per feed.
 */
export function useSingleFeedEpisodes(feedUrl: string, enabled: boolean) {
  return useQuery({
    queryKey: ['single-feed-episodes', feedUrl],
    queryFn: () => fetchFeed(feedUrl),
    enabled,
    staleTime: 1000 * 60 * 30,
    retry: 1,
  });
}

/**
 * Round-robin interleave: given an array of per-feed episode lists (each
 * already sorted newest-first), produce a single flat list that alternates
 * feeds so no single podcast dominates the queue.
 *
 * Algorithm:
 *   - Each feed gets a cursor starting at 0.
 *   - We cycle through feeds in order; each cycle picks one episode from the
 *     current feed's cursor and advances it.
 *   - Feeds that have run out of episodes are skipped.
 *   - This guarantees the pattern: A→B→C→A→B→C→… with graceful degradation
 *     when feeds have different episode counts.
 *
 * Example (3 feeds, 5 / 2 / 3 episodes):
 *   A0 B0 C0  A1 B1 C1  A2 C2  A3  A4
 *
 * The cap (MAX_PER_FEED) ensures that a prolific feed (e.g. hourly news)
 * never takes more slots than ceil(totalSlots / numFeeds).
 */
function roundRobinInterleave(perFeed: PodcastEpisode[][]): PodcastEpisode[] {
  const numFeeds = perFeed.length;
  if (numFeeds === 0) return [];
  if (numFeeds === 1) return perFeed[0]; // single feed — no interleaving needed

  const totalEpisodes = perFeed.reduce((s, f) => s + f.length, 0);
  const maxPerFeed    = Math.ceil(totalEpisodes / numFeeds);

  // Cap each feed at maxPerFeed so a high-volume feed can't dominate
  const capped  = perFeed.map(eps => eps.slice(0, maxPerFeed));
  const cursors = new Array<number>(numFeeds).fill(0);
  const result: PodcastEpisode[] = [];

  let remaining = capped.reduce((s, f) => s + f.length, 0);

  while (remaining > 0) {
    for (let fi = 0; fi < numFeeds; fi++) {
      if (cursors[fi] < capped[fi].length) {
        result.push(capped[fi][cursors[fi]++]);
        remaining--;
      }
    }
  }

  console.log(
    `[Podcast] round-robin queue: ${result.length} episodes from ${numFeeds} feeds` +
    ` (cap ${maxPerFeed}/feed, total raw ${totalEpisodes})`,
  );

  return result;
}

export function usePodcastEpisodes(feeds: PodcastFeed[]) {
  return useQuery({
    queryKey: ['podcast-episodes', feeds.map(f => f.url).join(',')],
    queryFn: async (): Promise<PodcastEpisode[]> => {
      // Fetch all feeds in parallel; failed feeds are skipped with a warning
      const results = await Promise.allSettled(feeds.map(f => fetchFeed(f.url)));

      const perFeed: PodcastEpisode[][] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') perFeed.push(r.value);
        else console.warn('[Podcast] feed failed:', r.reason);
      }

      // Each per-feed list is already sorted newest-first by fetchFeed.
      // Apply round-robin so the queue alternates between podcasts.
      return roundRobinInterleave(perFeed);
    },
    staleTime: 1000 * 60 * 30, // 30 min
    retry: 1,
  });
}
