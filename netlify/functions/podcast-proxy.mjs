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
 *   "json"      → Fetch any JSON URL server-side (?url=https://...)
 *                 Used for Podcast 2.0 chapter files (feeds.fountain.fm, etc.)
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

// ── action=json ───────────────────────────────────────────────────────────────

async function handleJson(params) {
  const url = params.url ?? '';
  if (!url) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing "url" query parameter' }),
    };
  }

  if (!/^https?:\/\//i.test(url)) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid URL scheme — only http/https allowed' }),
    };
  }

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'PersonalRadio/1.0 (chapters fetch)', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
    });

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Upstream returned HTTP ${res.status}` }),
      };
    }

    const json = await res.text(); // pass through as-is

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600', // chapters rarely change
      },
      body: json,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `JSON fetch failed: ${String(err)}` }),
    };
  }
}

// ── action=text ───────────────────────────────────────────────────────────────
// Fetches any text-based URL (SRT, WebVTT, plain JSON transcript, txt) and
// returns the raw body as text/plain. Used for Podcast 2.0 transcript files.

async function handleText(params) {
  const url = params.url ?? '';
  if (!url) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing "url" query parameter' }),
    };
  }

  if (!/^https?:\/\//i.test(url)) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid URL scheme — only http/https allowed' }),
    };
  }

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'PersonalRadio/1.0 (transcript fetch)',
        'Accept': 'text/plain, text/vtt, application/x-subrip, application/json, */*',
      },
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

    const text = await res.text();

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Text fetch failed: ${String(err)}` }),
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
    const maxParam = parseInt(params.max ?? '10', 10);
    const max = Number.isFinite(maxParam) && maxParam > 0 ? Math.min(maxParam, 40) : 10;
    piUrl = `${PI_BASE_URL}/search/byterm?q=${encodeURIComponent(q.trim())}&max=${max}`;
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

// ── action=audioresolver ───────────────────────────────────────────────────────
// Follows the redirect chain for a podcast audio URL server-side and returns
// only the final CDN URL as plain text — NOT the audio bytes.
//
// Why: iOS Safari blocks CORS redirects on <audio> elements (e.g. anchor.fm
// issues a 302 → CloudFront URL that has no CORS headers). By resolving the
// chain here and handing the direct CDN URL back to the browser, iOS can load
// the audio without any CORS redirect in the way.
//
// This fetches only the response headers (no body) so it is tiny and fast,
// well within Netlify Function size and timeout limits.

async function handleAudioResolver(params) {
  const url = params.url ?? '';
  if (!url) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing "url" query parameter' }),
    };
  }
  if (!/^https?:\/\//i.test(url)) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid URL scheme — only http/https allowed' }),
    };
  }

  try {
    // Follow all redirects but cancel the body immediately — we only need
    // res.url (the final URL after all 30x hops). Using GET rather than HEAD
    // because some podcast hosts reject HEAD requests.
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'PersonalRadio/1.0 (url-resolver)' },
    });
    // Discard the body without buffering any audio bytes.
    await res.body?.cancel();

    if (res.url.includes('.mp4')) {
      console.warn(`[Proxy] mp4 URL detected — may fail on iOS: ${res.url}`);
    }

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
      body: res.url,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `URL resolution failed: ${String(err)}` }),
    };
  }
}

// ── action=stream ─────────────────────────────────────────────────────────────
// Proxies podcast audio bytes server-side, forwarding the client's Range header
// and returning the upstream response with CORS + Accept-Ranges headers.
//
// Why: iOS Safari <audio> elements require CORS headers on every response in
// the redirect chain. CDN URLs served by podcast hosts (Spotify/Anchor,
// Megaphone, etc.) often lack CORS headers, causing silent playback failure.
// Routing through this proxy injects the missing headers.
//
// ⚠️  Netlify synchronous functions buffer the full response before sending.
//     This works for Range-based chunk requests (64 KB – 1 MB) but will fail
//     for full-file (no Range) fetches of large episodes. iOS Safari's
//     <audio> element typically sends Range: bytes=0-1 first to probe
//     Accept-Ranges support, then switches to chunked Range requests —
//     so in practice rangeless fetches are rare and usually small.
//     If large-file fetches become a problem, migrate to a Netlify Edge
//     Function (which supports true streaming with ReadableStream).

async function handleStream(event, params) {
  const url = params.url ?? '';
  if (!url) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing "url" query parameter' }),
    };
  }
  if (!/^https?:\/\//i.test(url)) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid URL scheme — only http/https allowed' }),
    };
  }

  // Forward the client's Range header so the upstream CDN can serve partial
  // content (206). Without this, seeking would require re-fetching from byte 0.
  const rangeHeader =
    event.headers['range'] ?? event.headers['Range'] ?? null;

  const upstreamHeaders = { 'User-Agent': 'PersonalRadio/1.0 (audio-stream)' };
  if (rangeHeader) upstreamHeaders['Range'] = rangeHeader;

  try {
    const res = await fetch(url, {
      headers: upstreamHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });

    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    // Always inject CORS + Accept-Ranges — this is the whole point of the proxy.
    const responseHeaders = {
      ...corsHeaders(),
      'Content-Type':  res.headers.get('content-type')  ?? 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    };

    // Pass through Content-Range and Content-Length so the browser can track
    // position and issue correct subsequent Range requests.
    const contentRange  = res.headers.get('content-range');
    const contentLength = res.headers.get('content-length');
    if (contentRange)  responseHeaders['Content-Range']  = contentRange;
    if (contentLength) responseHeaders['Content-Length'] = contentLength;

    return {
      statusCode:      res.status, // 200 or 206
      headers:         responseHeaders,
      body:            base64,
      isBase64Encoded: true,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Stream proxy failed: ${String(err)}` }),
    };
  }
}

// ── action=tts ────────────────────────────────────────────────────────────────
// Converts text to speech via ElevenLabs and returns audio/mpeg as binary.
// Expected JSON body: { text, voice_id, model_id?, voice_settings? }
// Uses ELEVENLABS_API_KEY from Netlify env (server-side, no VITE_ prefix).

async function handleTts(event) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'ELEVENLABS_API_KEY not configured' }),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body ?? '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const { text, voice_id } = parsed;
  const model_id = 'eleven_turbo_v2_5'; // hardcoded server-side — client value ignored
  const voice_settings = {
    stability:        0.40,
    similarity_boost: 0.75,
    style:            0.15,
    use_speaker_boost: true,
  };

  if (!text || !voice_id) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing required fields: text, voice_id' }),
    };
  }

  try {
    const ttsUrl =
      `https://api.elevenlabs.io/v1/text-to-speech/${voice_id}?output_format=mp3_44100_128`;

    const res = await fetch(ttsUrl, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text, model_id, voice_settings }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      return {
        statusCode: res.status,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `ElevenLabs TTS ${res.status}: ${errText}` }),
      };
    }

    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
      body: base64,
      isBase64Encoded: true,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `TTS proxy failed: ${String(err)}` }),
    };
  }
}

// ── action=stt ────────────────────────────────────────────────────────────────
// Forwards a multipart/form-data STT request to ElevenLabs Scribe v2.
// Expected form fields (passed through from client):
//   file           — audio blob (webm/ogg)
//   model_id       — e.g. "scribe_v2"
//   word_timestamps — "true"
//
// Uses ELEVENLABS_API_KEY from Netlify env (server-side, no VITE_ prefix).

async function handleStt(event) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'ELEVENLABS_API_KEY not configured' }),
    };
  }

  // Netlify encodes binary bodies as base64 when isBase64Encoded === true.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64')
    : Buffer.from(event.body ?? '');

  // Forward the original Content-Type (which carries the multipart boundary).
  const contentType =
    event.headers['content-type'] ?? event.headers['Content-Type'] ?? '';

  try {
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': contentType,
      },
      body: rawBody,
      signal: AbortSignal.timeout(45_000),
    });

    const body = await res.text();
    return {
      statusCode: res.status,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/json; charset=utf-8',
      },
      body,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `STT proxy failed: ${String(err)}` }),
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

  if (action === 'rss')           return handleRss(params);
  if (action === 'json')          return handleJson(params);
  if (action === 'text')          return handleText(params);
  if (action === 'audioresolver') return handleAudioResolver(params);
  if (action === 'stream')        return handleStream(event, params);
  if (action === 'tts')           return handleTts(event);
  if (action === 'stt')           return handleStt(event);
  return handlePodcastIndex(action, params);
};
