import { useQuery } from '@tanstack/react-query';

export interface WavlakeTrack {
  id: string;
  name: string;
  artist: string;
  artistId: string;
  albumTitle: string;
  albumId: string;
  artworkUrl: string;
  avatarUrl: string;
  liveUrl: string;
  duration: number;    // seconds
  isTopChart?: boolean; // true when fetched from the Top 40 chart
}

interface WavlakeSearchResult {
  id: string;
  type: 'track' | 'album' | 'artist';
  name: string;
  artist?: string;
  artistId?: string;
  albumTitle?: string;
  albumId?: string;
  artworkUrl: string;
  avatarUrl: string;
  liveUrl?: string;
  duration?: number;
}

interface WavlakeSearchResponse {
  success: boolean;
  data: WavlakeSearchResult[];
}

// Shape returned by the /top endpoint (different from /search)
interface WavlakeTopTrack {
  id: string;
  title: string;          // note: "title" not "name" on this endpoint
  artist: string;
  artistId?: string;
  albumTitle?: string;
  albumId?: string;
  artworkUrl: string;
  avatarUrl?: string;
  liveUrl: string;
  duration: number;       // seconds
  msat_total?: number;    // total Lightning sats earned (msats)
}

const WAVLAKE_BASE = 'https://catalog.wavlake.com/v1';

// ── Special mode ID ───────────────────────────────────────────────────────────
/** Sentinel value stored in localStorage to indicate Top Charts mode. */
export const TOP_CHARTS_ID = '__top_charts__';

// ── Genre catalogue ───────────────────────────────────────────────────────────
// Wavlake has no /genres endpoint — genre filtering works by using the genre
// name as the `term` search query. Each entry maps a display label to the
// search term(s) that retrieve tracks of that style. Multiple terms per genre
// are fanned out and merged so we get a fuller result set.
export interface Genre {
  id: string;        // stable key for localStorage / queryKey
  label: string;     // display name shown in the UI
  terms: string[];   // search terms sent to the Wavlake API
}

export const GENRES: Genre[] = [
  { id: 'ambient',     label: 'Ambient',     terms: ['ambient'] },
  { id: 'electronic',  label: 'Electronic',  terms: ['electronic', 'synth'] },
  { id: 'lofi',        label: 'Lo-Fi',       terms: ['lofi', 'lo-fi', 'chill'] },
  { id: 'rock',        label: 'Rock',        terms: ['rock'] },
  { id: 'folk',        label: 'Folk',        terms: ['folk', 'acoustic'] },
  { id: 'jazz',        label: 'Jazz',        terms: ['jazz'] },
  { id: 'classical',   label: 'Classical',   terms: ['classical', 'piano'] },
  { id: 'hiphop',      label: 'Hip-Hop',     terms: ['hip hop', 'rap', 'beats'] },
];

export const ALL_GENRE_IDS = GENRES.map(g => g.id);

// ── Fetching ──────────────────────────────────────────────────────────────────

async function fetchTracksForQuery(query: string): Promise<WavlakeTrack[]> {
  const url = `${WAVLAKE_BASE}/search?term=${encodeURIComponent(query)}&limit=20`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wavlake search failed for "${query}": ${res.status}`);
  const json: WavlakeSearchResponse = await res.json();

  return json.data
    .filter(
      (item): item is WavlakeSearchResult & { liveUrl: string; duration: number; artist: string } =>
        item.type === 'track' &&
        typeof item.liveUrl === 'string' &&
        item.liveUrl.length > 0 &&
        typeof item.duration === 'number' &&
        item.duration > 30 &&   // skip very short clips
        item.duration <= 300 && // skip tracks longer than 5 minutes
        typeof item.artist === 'string'
    )
    .map((item) => ({
      id: item.id,
      name: item.name,
      artist: item.artist,
      artistId: item.artistId ?? '',
      albumTitle: item.albumTitle ?? '',
      albumId: item.albumId ?? '',
      artworkUrl: item.artworkUrl,
      avatarUrl: item.avatarUrl,
      liveUrl: item.liveUrl,
      duration: item.duration,
    }));
}

/** Fetch the Wavlake Top 40 — tracks ranked by Lightning tips from listeners. */
export async function fetchTopTracks(limit = 40): Promise<WavlakeTrack[]> {
  const res = await fetch(`${WAVLAKE_BASE}/top?limit=${limit}`);
  if (!res.ok) throw new Error(`Wavlake Top Charts fetch failed: ${res.status}`);

  const data: WavlakeTopTrack[] = await res.json();

  return data
    .filter(
      (t) =>
        typeof t.liveUrl === 'string' &&
        t.liveUrl.length > 0 &&
        typeof t.duration === 'number' &&
        t.duration <= 300, // same 5-minute cap as genre search
    )
    .map((t) => ({
      id: t.id,
      name: t.title,          // /top uses "title" instead of "name"
      artist: t.artist,
      artistId: t.artistId ?? '',
      albumTitle: t.albumTitle ?? '',
      albumId: t.albumId ?? '',
      artworkUrl: t.artworkUrl,
      avatarUrl: t.avatarUrl ?? '',
      liveUrl: t.liveUrl,
      duration: t.duration,
      isTopChart: true,       // mark every track from this endpoint
    }));
}

/** Deduplicate tracks by ID and shuffle */
function dedupeAndShuffle(tracks: WavlakeTrack[]): WavlakeTrack[] {
  const seen = new Set<string>();
  const unique = tracks.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
  // Fisher-Yates shuffle
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }
  return unique;
}

/**
 * Fetch tracks from Wavlake.
 *
 * If `selectedGenreIds` contains only `TOP_CHARTS_ID`, fetches the Top 40.
 * Otherwise fetches by genre search terms as before.
 *
 * @param selectedGenreIds  Array of Genre.id strings, or [TOP_CHARTS_ID].
 */
export function useWavlakeTracks(selectedGenreIds: string[] = ALL_GENRE_IDS) {
  const isTopChartsMode = selectedGenreIds.includes(TOP_CHARTS_ID);

  return useQuery({
    // Distinct cache key for top-charts vs genre queries
    queryKey: ['wavlake-tracks', isTopChartsMode ? 'top-charts' : [...selectedGenreIds].sort().join(',')],
    queryFn: async (): Promise<WavlakeTrack[]> => {
      if (isTopChartsMode) {
        const tracks = await fetchTopTracks(40);
        if (tracks.length === 0) throw new Error('No tracks returned from Wavlake Top Charts');
        // Top Charts preserves chart order (no shuffle) — positions matter
        return tracks;
      }

      // ── Genre mode (unchanged from original) ──────────────────────────────
      const activeGenres = GENRES.filter(g => selectedGenreIds.includes(g.id));
      const genresToFetch = activeGenres.length > 0 ? activeGenres : GENRES;
      const terms = [...new Set(genresToFetch.flatMap(g => g.terms))];

      const results = await Promise.allSettled(terms.map(fetchTracksForQuery));
      const allTracks: WavlakeTrack[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') allTracks.push(...result.value);
      }

      if (allTracks.length === 0) {
        throw new Error('No tracks available from Wavlake for selected genres');
      }

      return dedupeAndShuffle(allTracks).slice(0, 30);
    },
    staleTime: 1000 * 60 * 10, // 10 minutes
    retry: 2,
  });
}
