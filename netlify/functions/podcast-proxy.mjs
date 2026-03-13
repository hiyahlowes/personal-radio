/**
 * Netlify Function: podcast-proxy
 *
 * Proxies requests to the PodcastIndex API, keeping credentials server-side
 * so they are never exposed to the browser (and avoiding CORS entirely).
 *
 * Supported query params:
 *   action  "search"   → GET /api/1.0/search/byterm?q=<q>&max=10
 *           "trending" → GET /api/1.0/podcasts/trending?max=10&lang=en
 *   q       Search term (required for action=search)
 *
 * Environment variables (set in Netlify dashboard — no VITE_ prefix):
 *   PODCASTINDEX_API_KEY
 *   PODCASTINDEX_API_SECRET
 */

const BASE_URL = 'https://api.podcastindex.org/api/1.0';

/** SHA-1 via the Node.js crypto module (available in Netlify Functions). */
async function sha1Hex(str) {
  const { createHash } = await import('node:crypto');
  return createHash('sha1').update(str).digest('hex');
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export const handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  const apiKey    = process.env.PODCASTINDEX_API_KEY;
  const apiSecret = process.env.PODCASTINDEX_API_SECRET;

  if (!apiKey || !apiSecret) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'PodcastIndex credentials not configured' }),
    };
  }

  const params  = event.queryStringParameters ?? {};
  const action  = params.action ?? 'search';
  const q       = params.q ?? '';

  // Build PodcastIndex auth headers
  const timestamp = Math.floor(Date.now() / 1000);
  const hash      = await sha1Hex(apiKey + apiSecret + timestamp);

  const piHeaders = {
    'X-Auth-Key':    apiKey,
    'X-Auth-Date':   String(timestamp),
    'Authorization': hash,
    'User-Agent':    'PersonalRadio/1.0',
  };

  let piUrl;
  if (action === 'trending') {
    piUrl = `${BASE_URL}/podcasts/trending?max=10&lang=en&cat=&notcat=`;
  } else {
    // default: search
    if (!q.trim()) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing query parameter "q"' }),
      };
    }
    piUrl = `${BASE_URL}/search/byterm?q=${encodeURIComponent(q.trim())}&max=10`;
  }

  try {
    const res = await fetch(piUrl, {
      headers: piHeaders,
      signal: AbortSignal.timeout(10_000),
    });

    const body = await res.text();

    return {
      statusCode: res.status,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/json',
        'Cache-Control': action === 'trending' ? 'public, max-age=300' : 'no-store',
      },
      body,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(err) }),
    };
  }
};
