/**
 * Netlify Function: wavlake-pay
 *
 * Server-side proxy for the Wavlake LNURL-pay flow.
 * Runs all steps server-side to avoid CORS restrictions and keep the
 * appId referrer (personal-radio → 5% fee split to PR) off the client.
 *
 * Flow:
 *   1. Fetch LNURL string from Wavlake API (contentId + appId=personal-radio)
 *   2. Decode LNURL bech32 → metadata URL
 *   3. Fetch metadata URL → get { callback, minSendable, maxSendable }
 *   4. If amount < minSendable → return { below_minimum: true, minSendableSats }
 *   5. Fetch callback?amount={clamped} → get { pr: "lnbc..." }
 *   6. Return { pr } ready for NWC payInvoice
 *
 * GET /.netlify/functions/wavlake-pay?contentId={uuid}&amountMsats={number}
 */

// Minimal bech32 decoder — no external dependencies needed.
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function decodeLnurl(lnurl) {
  const lower = lnurl.toLowerCase();
  const sep   = lower.lastIndexOf('1');
  if (sep < 1 || sep + 7 > lower.length) throw new Error('Invalid LNURL bech32 string');
  // Strip the 6-char checksum from the end
  const dataPart = lower.slice(sep + 1, lower.length - 6);
  const vals = [];
  for (const c of dataPart) {
    const idx = BECH32_CHARSET.indexOf(c);
    if (idx === -1) throw new Error(`Invalid bech32 character: ${c}`);
    vals.push(idx);
  }
  // Convert 5-bit groups to 8-bit bytes
  let acc = 0, bits = 0;
  const bytes = [];
  for (const val of vals) {
    acc   = (acc << 5) | val;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  const params      = event.queryStringParameters ?? {};
  const contentId   = params.contentId ?? '';
  const amountMsats = parseInt(params.amountMsats ?? '0', 10);

  if (!contentId) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing contentId' }),
    };
  }
  if (!amountMsats || amountMsats <= 0) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing or invalid amountMsats' }),
    };
  }

  try {
    // Step 1 — get LNURL string from Wavlake
    console.log(`[wavlake-pay] fetching LNURL for track ${contentId}, ${amountMsats} msats`);
    const lnurlRes = await fetch(
      `https://wavlake.com/api/v1/lnurl?contentId=${encodeURIComponent(contentId)}&appId=personal-radio`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!lnurlRes.ok) throw new Error(`Wavlake LNURL endpoint returned HTTP ${lnurlRes.status}`);
    const { lnurl } = await lnurlRes.json();
    if (!lnurl) throw new Error('Wavlake LNURL response missing lnurl field');

    // Step 2 — decode LNURL bech32 → metadata URL
    const metadataUrl = decodeLnurl(lnurl);
    console.log(`[wavlake-pay] decoded metadata URL: ${metadataUrl}`);

    // Step 3 — fetch LNURL-pay metadata
    const metaRes = await fetch(metadataUrl, { signal: AbortSignal.timeout(10_000) });
    if (!metaRes.ok) throw new Error(`LNURL metadata fetch returned HTTP ${metaRes.status}`);
    const meta = await metaRes.json();
    if (meta.tag !== 'payRequest') throw new Error(`Unexpected LNURL tag: ${meta.tag}`);

    // Step 4 — check amount against minSendable
    if (amountMsats < meta.minSendable) {
      const minSendableSats = Math.ceil(meta.minSendable / 1000);
      console.log(`[wavlake-pay] amount ${amountMsats} msats below minimum ${meta.minSendable} msats`);
      return {
        statusCode: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ below_minimum: true, minSendableSats }),
      };
    }

    const clamped = Math.min(amountMsats, meta.maxSendable);

    // Step 5 — fetch invoice from callback
    const cbUrl = new URL(meta.callback);
    cbUrl.searchParams.set('amount', String(clamped));
    console.log(`[wavlake-pay] fetching invoice: ${cbUrl.toString()}`);
    const invoiceRes = await fetch(cbUrl.toString(), { signal: AbortSignal.timeout(15_000) });
    if (!invoiceRes.ok) throw new Error(`Invoice callback returned HTTP ${invoiceRes.status}`);
    const invoiceData = await invoiceRes.json();
    if (!invoiceData.pr) throw new Error('No bolt11 invoice in Wavlake callback response');

    console.log(`[wavlake-pay] invoice ready for ${clamped} msats`);
    return {
      statusCode: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ pr: invoiceData.pr }),
    };
  } catch (err) {
    console.error('[wavlake-pay] error:', err);
    return {
      statusCode: 502,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(err) }),
    };
  }
};
