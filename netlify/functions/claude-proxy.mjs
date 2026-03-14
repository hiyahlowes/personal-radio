/**
 * Netlify Function: claude-proxy
 *
 * Proxies POST requests to the Anthropic Messages API server-side to
 * avoid CORS restrictions in the browser.
 *
 * Expected request body (JSON):
 *   { system, messages, model, max_tokens }
 *
 * Environment variables (set in Netlify dashboard — no VITE_ prefix):
 *   ANTHROPIC_API_KEY
 */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[claude-proxy] ANTHROPIC_API_KEY is not set');
    return new Response(JSON.stringify({ error: 'Server misconfiguration: missing API key' }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const { system, messages, model, max_tokens } = body;

  const requestBody = JSON.stringify({ system, messages, model, max_tokens });
  console.log('[Claude Proxy] Sending body:', requestBody);
  console.log('[Claude Proxy] API key length:', process.env.ANTHROPIC_API_KEY?.length);
  console.log('[Claude Proxy] API key prefix:', process.env.ANTHROPIC_API_KEY?.substring(0, 10));

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: requestBody,
  });

  if (!upstream.ok) {
    const errorText = await upstream.text();
    console.log('[Claude Proxy] Error response:', errorText);
    return new Response(errorText, {
      status: upstream.status,
      headers: { ...corsHeaders(), 'Content-Type': 'text/plain' },
    });
  }

  const json = await upstream.json();

  return new Response(JSON.stringify(json), {
    status: upstream.status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}
