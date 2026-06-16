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

export function shouldUseViaModeration(body, env = process.env) {
  return body?.purpose === 'radio-moderation' && env.PERSONAL_RADIO_USE_VIA === 'true';
}

async function runViaModeration(body, env = process.env) {
  const port = Number(env.VIA_MODERATOR_PORT || 8902);
  const timeout = Number(env.PERSONAL_RADIO_HERMES_TIMEOUT_MS || 120000);

  const res = await fetch(`http://127.0.0.1:${port}/moderation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => res.statusText);
    throw new Error(`Via moderator service ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const json = await res.json();
  const text = json?.content?.[0]?.text?.trim();
  if (!text) throw new Error('Via moderator service returned empty text');
  return text;
}

function anthropicTextResponse(text) {
  return {
    id: `via-radio-${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: 'via-nova-hermes',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
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

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  if (shouldUseViaModeration(body)) {
    try {
      const text = await runViaModeration(body);
      return new Response(JSON.stringify(anthropicTextResponse(text)), {
        status: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.warn('[claude-proxy] Via moderation failed, falling back to Anthropic:', err?.message || err);
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[claude-proxy] ANTHROPIC_API_KEY is not set');
    return new Response(JSON.stringify({ error: 'Server misconfiguration: missing API key' }), {
      status: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }

  const { system, messages, model, max_tokens } = body;

  const requestBody = JSON.stringify({ system, messages, model, max_tokens });
  console.log('[Claude Proxy] Sending request to Anthropic:', { model, max_tokens, messageCount: Array.isArray(messages) ? messages.length : 0, hasSystem: Boolean(system) });

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
