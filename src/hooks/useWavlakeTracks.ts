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
  duration: number; // seconds
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

const WAVLAKE_BASE = 'https://catalog.wavlake.com/v1';

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
 * Fetch tracks from Wavlake for the given genre IDs.
 *
 * @param selectedGenreIds  Array of Genre.id strings. Defaults to all genres.
 */
export function useWavlakeTracks(selectedGenreIds: string[] = ALL_GENRE_IDS) {
  // Resolve selected genres → deduplicated list of search terms
  const activeGenres = GENRES.filter(g => selectedGenreIds.includes(g.id));
  // Fall back to all genres if nothing is selected (shouldn't happen via UI,
  // but guards against an empty array producing zero tracks)
  const genresToFetch = activeGenres.length > 0 ? activeGenres : GENRES;
  const terms = [...new Set(genresToFetch.flatMap(g => g.terms))];

  return useQuery({
    // Include the sorted genre IDs in the key so switching genres refetches
    queryKey: ['wavlake-tracks', [...selectedGenreIds].sort().join(',')],
    queryFn: async (): Promise<WavlakeTrack[]> => {
      // Fan out all terms in parallel
      const results = await Promise.allSettled(terms.map(fetchTracksForQuery));

      const allTracks: WavlakeTrack[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          allTracks.push(...result.value);
        }
      }

      if (allTracks.length === 0) {
        throw new Error('No tracks available from Wavlake for selected genres');
      }

      return dedupeAndShuffle(allTracks).slice(0, 30); // cap at 30 tracks
    },
    staleTime: 1000 * 60 * 10, // 10 minutes
    retry: 2,
  });
}
