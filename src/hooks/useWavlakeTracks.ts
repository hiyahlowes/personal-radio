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

// Search terms to build a varied, listenable radio playlist
const SEARCH_QUERIES = ['ambient', 'lofi', 'chill', 'acoustic', 'electronic'];

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
        item.duration > 30 && // skip very short clips
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

export function useWavlakeTracks() {
  return useQuery({
    queryKey: ['wavlake-tracks'],
    queryFn: async (): Promise<WavlakeTrack[]> => {
      // Fan out to multiple genre queries in parallel
      const results = await Promise.allSettled(
        SEARCH_QUERIES.map((q) => fetchTracksForQuery(q))
      );

      const allTracks: WavlakeTrack[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          allTracks.push(...result.value);
        }
      }

      if (allTracks.length === 0) {
        throw new Error('No tracks available from Wavlake');
      }

      return dedupeAndShuffle(allTracks).slice(0, 30); // cap at 30 tracks
    },
    staleTime: 1000 * 60 * 10, // 10 minutes
    retry: 2,
  });
}
