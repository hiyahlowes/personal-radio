/**
 * Netlify Function: wavlake-charts
 *
 * Fetches the current Wavlake Top 40 by scraping wavlake.com/top and
 * extracting the embedded __NEXT_DATA__ JSON. This avoids CORS issues and
 * gives the client fresh chart data on every call.
 *
 * GET /.netlify/functions/wavlake-charts
 * Returns: { success: true, data: WavlakeTrackSummary[] }
 */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  try {
    const res = await fetch('https://wavlake.com/top', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PersonalRadio/1.0)',
        'Accept': 'text/html',
      },
    });

    if (!res.ok) {
      throw new Error(`wavlake.com/top returned ${res.status}`);
    }

    const html = await res.text();

    // Next.js embeds server-side props in a <script id="__NEXT_DATA__"> tag
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) {
      throw new Error('Could not find __NEXT_DATA__ in wavlake.com/top');
    }

    const nextData = JSON.parse(match[1]);
    const topTracks = nextData?.props?.pageProps?.topTracks;

    if (!Array.isArray(topTracks) || topTracks.length === 0) {
      throw new Error('topTracks not found in __NEXT_DATA__');
    }

    // Return just the fields the client needs
    const data = topTracks.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      artistId: t.artistId ?? '',
      albumTitle: t.albumTitle ?? '',
      albumId: t.albumId ?? '',
      artworkUrl: t.artworkUrl ?? '',
      avatarUrl: t.avatarUrl ?? '',
      liveUrl: t.liveUrl ?? '',
      duration: t.duration ?? 0,
      msatTotal: t.msatTotal ?? '0',
    }));

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/json',
        // No caching — always serve fresh chart data
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({ success: true, data }),
    };
  } catch (err) {
    console.error('[wavlake-charts] error:', err);
    return {
      statusCode: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: String(err) }),
    };
  }
};
