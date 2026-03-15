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
  genreId?: string;     // genre used to fetch this track (e.g. 'ambient')
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

// Shape returned by the /v1/tracks/:id endpoint
interface WavlakeTrackDetail {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  albumTitle?: string;
  albumId?: string;
  artworkUrl: string;
  avatarUrl?: string;
  liveUrl: string;
  duration: number;
  msatTotal?: string;
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

async function fetchTracksForQuery(query: string, genreId: string): Promise<WavlakeTrack[]> {
  const url = `${WAVLAKE_BASE}/search?term=${encodeURIComponent(query)}&limit=20`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wavlake search failed for "${query}": ${res.status}`);
  const json: WavlakeSearchResponse = await res.json();

  if (json.data?.length > 0) {
    console.log('[Wavlake] raw first track (all fields):', JSON.stringify(json.data[0], null, 2));
  }

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
      genreId,
    }));
}

/**
 * Current Wavlake Top 40 track IDs (ranked by Lightning sats from listeners).
 *
 * The Wavlake catalog API has no public /top or /charts endpoint — the Top 40
 * page is server-side rendered. We fetch each track individually via
 * /v1/tracks/:id, which is stable and always returns current metadata.
 *
 * Source: https://wavlake.com/top (fetched 2026-03-13)
 */
const TOP_40_IDS: string[] = [
  '4d3443ba-4ec9-41a7-bf0a-78dc35896aa4', // 1  Backseat Driver — Joe Martin
  '1b4df345-2f99-425d-9ed4-23102bbce147', // 2  Under These Lights (Acoustic) — Corey Keller
  '1c500b27-d0c0-4e67-abb9-c0eecda5af53', // 3  An immaculate conception — EasyWiz
  '47aab0a2-1cc0-46ac-b569-053dc90ee286', // 4  Tick Tock Next Block — Nope
  'dac15380-8384-4b8d-9074-ff06c99f6813', // 5  crash+burn — IROH
  '8fe63588-86f4-4ac8-aff4-4c9e0b88a164', // 6  Build on Stone — Haleen
  '565c5057-4809-4e75-a4e7-faf6daa08e58', // 7  In Between — Ollie
  'e33d0f0b-76ed-493e-9801-433e7649d2d0', // 8  Most Amazing — WILLPOWER
  'ecad286b-e9d0-485e-b63c-28b9caebaeb0', // 9  Night Street — EpochNative
  'ab1af6c6-8ff5-4317-8497-9699341f30de', // 10 Feuer über Fiat — PlebRap
  '8df3f2f2-998a-4f8a-acef-650aa3eee538', // 11 Das Geldsystem ist krank — PlebRap
  '8dd2d1a8-1658-49e2-a74a-e720e252b080', // 12 Abyssal — EpochNative
  '06335d63-0667-4bd8-8a20-636434d1d379', // 13 Eternal Drift — EpochNative
  'a76b684b-994a-4eba-8f5f-eccddd473ced', // 14 Too Bit To Fail - Moon Ätherisierung — PlebRap
  '4e6eb303-ce33-416d-afea-e10291b03901', // 15 Behind Me — EpochNative
  'a27e6d74-f53a-4eca-acb4-aa20ad97e0dd', // 16 Closer To Somewhere — The Retrograde
  '5c33d104-67fb-4750-9dd6-5a66974860ba', // 17 Plebs together strong — PlebRap
  'db8c251d-5982-448c-b30d-8194d7021791', // 18 Too Bit To Fail - SHA 'o' lin — PlebRap
  'b5735454-89f6-4860-946a-9b86bd1d2188', // 19 Bubble Trouble — PlebRap
  'a6094897-0a5c-49e3-b72b-08ba6bcb4f4d', // 20 Bank gegen Node — PlebRap
  '16b656a7-265f-4536-b2ac-3984efb434ce', // 21 The Block (Time, Energy, Sats) — Richard
  'a1cd3b2f-de89-4707-9c42-8aa8eaedac74', // 22 BLUE — EpochNative
  'fcf66b3a-dbfa-467c-9e0d-7ed9a77e36ee', // 23 Exit — Richard
  '87cc1e14-943c-4358-9ede-fdf1b4bb2645', // 24 Live While I'm Alive — Abel James
  '7b7649ba-e89f-4104-ab03-d83b8a275760', // 25 Validate — Richard
  'd71c3470-ef7a-40aa-8608-d7466b55d083', // 26 One Dead Ember — Johnny Delagrange
  '35e81e15-6820-4f83-9a3d-4ef2cf0da14b', // 27 Endless Deja Vu — My Friend Jimi
  'e5b11284-4634-4a77-a0da-e3f59dd09a6b', // 28 UTXO (The Transaction) — Richard
  '4d5bcf57-b3c5-426d-a92d-9ae192b99425', // 29 Timekeeper — Richard
  'a742ad2b-7da7-4e35-a040-6d4db56980da', // 30 I'm Still Here — Longy
  '3c4ab272-067d-4700-8346-5c3e14a20869', // 31 Just One More Time — Oliver Prentice
  '4b985617-6e41-47aa-b540-ecca8b693eb7', // 32 A Phoenix Rising — Haleen
  'b60e20d6-90f8-4620-8467-bb92167f77d8', // 33 Layer One — Richard
  '4cf55d52-d203-44e7-a1f9-7cf637bf99f8', // 34 The Nakamotor ft. Guywithafork — Richard
  '9c369389-8f84-4231-91fb-4132a3944297', // 35 Azul Verde Plasma — Yoshiro Mare
  '9f0405f3-f9f6-4f8b-b1de-053308c47c47', // 36 Futile — Look Ma, No Cavities!
  'e5868269-6e62-45b2-8efd-4be67ca618f7', // 37 Transistors — Texas 121
  'ab30278f-b165-408d-aba2-0514f9045c80', // 38 nameless — Hurling Pixels
  '757bff9e-f93d-4da3-842b-186cab437c02', // 39 Sunny Day — Oliver Prentice
  '7ffbd332-661f-44e7-a089-a58ea6183e97', // 40 Houses in the Heart — EpochNative
];

/** Fetch the Wavlake Top 40 by resolving each track via /v1/tracks/:id */
export async function fetchTopTracks(limit = 40): Promise<WavlakeTrack[]> {
  const ids = TOP_40_IDS.slice(0, limit);

  const results = await Promise.allSettled(
    ids.map(id => fetch(`${WAVLAKE_BASE}/tracks/${id}`).then(r => r.json()))
  );

  const tracks: WavlakeTrack[] = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const t: WavlakeTrackDetail = result.value?.data;
    if (
      !t ||
      typeof t.liveUrl !== 'string' ||
      !t.liveUrl ||
      typeof t.duration !== 'number'
    ) continue;

    tracks.push({
      id: t.id,
      name: t.title,
      artist: t.artist,
      artistId: t.artistId ?? '',
      albumTitle: t.albumTitle ?? '',
      albumId: t.albumId ?? '',
      artworkUrl: t.artworkUrl,
      avatarUrl: t.avatarUrl ?? '',
      liveUrl: t.liveUrl,
      duration: t.duration,
      isTopChart: true,
    });
  }

  return tracks;
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

      // ── Genre mode ────────────────────────────────────────────────────────
      const activeGenres = GENRES.filter(g => selectedGenreIds.includes(g.id));
      const genresToFetch = activeGenres.length > 0 ? activeGenres : GENRES;
      // Expand each genre into { term, genreId } pairs so tracks can be tagged
      const termEntries = genresToFetch.flatMap(g => g.terms.map(term => ({ term, genreId: g.id })));

      const results = await Promise.allSettled(
        termEntries.map(({ term, genreId }) => fetchTracksForQuery(term, genreId)),
      );
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
