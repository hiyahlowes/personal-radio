/**
 * Netlify Function: podcast-proxy
 *
 * Proxies requests server-side to avoid CORS issues and keep API credentials
 * out of the browser.
 *
 * Supported actions (via ?action=...):
 *
 *   "trending"  → GET PodcastIndex /podcasts/trending
 *   "search"    → GET PodcastIndex /search/byterm?q=<q>
 *   "rss"       → Fetch any RSS/Atom feed URL server-side (?url=https://...)
 *                 Returns the raw XML with appropriate headers.
 *
 * Environment variables (set in Netlify dashboard — no VITE_ prefix):
 *   PODCASTINDEX_API_KEY
 *   PODCASTINDEX_API_SECRET
 */

const PI_BASE_URL = 'https://api.podcastindex.org/api/1.0';

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

// ── action=rss ────────────────────────────────────────────────────────────────

async function handleRss(params) {
  const url = params.url ?? '';
  if (!url) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing "url" query parameter' }),
    };
  }

  // Only allow http(s) URLs — block file://, data:, etc.
  if (!/^https?:\/\//i.test(url)) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid URL scheme — only http/https allowed' }),
    };
  }

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'PersonalRadio/1.0 (RSS fetch)' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Upstream returned HTTP ${res.status}` }),
      };
    }

    const xml = await res.text();

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300', // 5-minute cache
      },
      body: xml,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `RSS fetch failed: ${String(err)}` }),
    };
  }
}

// ── action=trending / action=search (PodcastIndex) ────────────────────────────

async function handlePodcastIndex(action, params) {
  const apiKey    = process.env.PODCASTINDEX_API_KEY;
  const apiSecret = process.env.PODCASTINDEX_API_SECRET;

  if (!apiKey || !apiSecret) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'PodcastIndex credentials not configured' }),
    };
  }

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
    piUrl = `${PI_BASE_URL}/podcasts/trending?max=10&lang=en&cat=&notcat=`;
  } else {
    // search
    const q = params.q ?? '';
    if (!q.trim()) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing query parameter "q"' }),
      };
    }
    piUrl = `${PI_BASE_URL}/search/byterm?q=${encodeURIComponent(q.trim())}&max=10`;
  }

  try {
    const res  = await fetch(piUrl, { headers: piHeaders, signal: AbortSignal.timeout(10_000) });
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
}

// ── Main handler ──────────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  const params = event.queryStringParameters ?? {};
  const action = params.action ?? 'search';

  if (action === 'rss') {
    return handleRss(params);
  }

  return handlePodcastIndex(action, params);
};
