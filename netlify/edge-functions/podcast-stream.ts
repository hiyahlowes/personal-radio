/**
 * Netlify Edge Function: podcast-stream
 *
 * Proxies podcast audio with true streaming (no buffering) and injects the
 * CORS + Accept-Ranges headers that iOS Safari requires to play <audio>.
 *
 * Why an Edge Function instead of a serverless Function:
 *   - Serverless functions buffer the full response before sending (6 MB limit).
 *     A 60-minute podcast at 128 kbps is ~55 MB — impossible to proxy that way.
 *   - Edge Functions run on Deno and can pipe a ReadableStream directly, so the
 *     client starts receiving bytes immediately with no memory cap.
 *
 * Route: /podcast-stream?url=<encoded-audio-url>
 * Configured in netlify.toml [[edge_functions]].
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':   '*',
  'Access-Control-Allow-Methods':  'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers':  'Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

export default async (request: Request): Promise<Response> => {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url') ?? '';

  if (!url) {
    return new Response(JSON.stringify({ error: 'Missing "url" parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  if (!/^https?:\/\//i.test(url)) {
    return new Response(JSON.stringify({ error: 'Invalid URL scheme — only http/https allowed' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  // Forward Range header so the upstream CDN can serve 206 Partial Content.
  // This is essential for seeking — without it the browser must re-fetch from 0.
  const upstreamHeaders: Record<string, string> = {
    'User-Agent': 'PersonalRadio/1.0 (edge-stream)',
  };
  const rangeHeader = request.headers.get('Range') ?? request.headers.get('range');
  if (rangeHeader) upstreamHeaders['Range'] = rangeHeader;

  try {
    const upstream = await fetch(url, {
      headers: upstreamHeaders,
      redirect: 'follow',
    });

    // Build response headers — always inject CORS + Accept-Ranges.
    const responseHeaders = new Headers(CORS_HEADERS);
    responseHeaders.set('Accept-Ranges', 'bytes');

    const contentType = upstream.headers.get('content-type');
    responseHeaders.set('Content-Type', contentType ?? 'audio/mpeg');

    // Pass through Content-Range and Content-Length so the browser knows
    // the byte boundaries and can issue correct subsequent Range requests.
    const contentRange  = upstream.headers.get('content-range');
    const contentLength = upstream.headers.get('content-length');
    if (contentRange)  responseHeaders.set('Content-Range',  contentRange);
    if (contentLength) responseHeaders.set('Content-Length', contentLength);

    // Stream the body directly — Deno pipes ReadableStream with zero buffering.
    return new Response(upstream.body, {
      status:  upstream.status, // 200 or 206
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Stream failed: ${String(err)}` }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
};
