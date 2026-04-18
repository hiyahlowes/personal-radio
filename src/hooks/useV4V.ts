/**
 * useV4V — Value4Value sat-streaming hook for Personal Radio
 *
 * Implements NIP-47 (NWC) + Podcast 2.0 / bLIP-10 value streaming:
 *  - Accumulates sats per minute across tracks (cross-song batching)
 *  - Flushes via: 15-min interval | 5-min pause | tab close/hide
 *  - Supports pay_keysend (node pubkeys) and pay_invoice via LNURL (lightning addresses)
 *  - Optional PR split: redirects a percentage of sats to Personal Radio
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import type { ValueTag, ValueRecipient, ItemMeta, PendingPayment, FlushResult } from '@/types/value4value';

// ── localStorage keys ─────────────────────────────────────────────────────────
const NWC_CONN_KEY        = 'nwc_connection';
const NWC_SAT_RATE_KEY    = 'nwc_sat_rate';
const NWC_SUPPORT_PR_KEY  = 'nwc_support_pr';
const NWC_PR_SPLIT_KEY    = 'nwc_pr_split';
const NWC_SENDER_ID_KEY   = 'nwc_sender_id';
const NWC_PENDING_KEY     = 'nwc_pending_buffer';

const PR_LIGHTNING_ADDRESS  = 'accoladecool329256@getalby.com';
const MIN_FLUSH_SATS        = 10;   // don't send payments below this threshold
const MAX_PENDING_SATS      = 500;  // drop accumulated sats above this cap per recipient
const MAX_CONSEC_FAILURES   = 3;    // disable a recipient after this many consecutive failures

// Wavlake keysend constants — used as fallback when the LNURL API is unavailable.
// Verified from Wavlake RSS feeds: all tracks route through this node;
// customValue (track UUID) tells Wavlake which artist to credit.
const WAVLAKE_LN_NODE    = '02682b7c86f474d082fa9d274c3751291225448468691784c6f112187de975a8c2';
const WAVLAKE_CUSTOM_KEY = '16180339';
const MAX_BUFFER_AGE_MS    = 30 * 60 * 1000; // flush stale entries after 30 min
const FLUSH_INTERVAL_MS    = 15 * 60 * 1000; // 15-minute periodic flush
const PAUSE_FLUSH_MS       = 5  * 60 * 1000; // flush after 5-min pause

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Retry a payment call up to `maxAttempts` times with linear backoff.
 * Used for both keysend and lnaddress payments where relay lag can cause
 * false "reply timeout" errors even when the payment actually succeeded.
 */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts: number, label: string): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Timeout errors: every retry wastes another 60 s — fail fast instead
      if (msg.toLowerCase().includes('reply timeout') || msg.toLowerCase().includes('timed out')) {
        throw e;
      }
      if (attempt < maxAttempts) {
        const delay = 3000 * attempt;
        console.log(`[V4V] attempt ${attempt}/${maxAttempts} failed for "${label}" — retrying in ${delay / 1000}s`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw e;
      }
    }
  }
  throw new Error('unreachable');
}

function getOrCreateSenderId(): string {
  let id = localStorage.getItem(NWC_SENDER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(NWC_SENDER_ID_KEY, id);
  }
  return id;
}

function loadBuffer(): Map<string, PendingPayment> {
  try {
    const raw = localStorage.getItem(NWC_PENDING_KEY);
    if (!raw) return new Map();
    const arr = JSON.parse(raw) as [string, PendingPayment][];
    return new Map(arr);
  } catch {
    return new Map();
  }
}

function saveBuffer(buf: Map<string, PendingPayment>) {
  localStorage.setItem(NWC_PENDING_KEY, JSON.stringify([...buf.entries()]));
}

/**
 * Scale feed recipients to leave room for the PR split, then append PR.
 * Wavlake tracks are excluded — PR's 5% split is already included via the
 * appId=personal-radio referrer in the LNURL call (handled server-side).
 */
function buildRecipients(
  feedRecipients: ValueRecipient[],
  supportPR: boolean,
  prSplitPercent: number,
): ValueRecipient[] {
  if (!supportPR || prSplitPercent <= 0) return feedRecipients;

  // Wavlake's LNURL (appId=personal-radio) already includes 5% PR + 5% Wavlake = 10%
  // built-in. Only add a PR recipient for the portion the user requested ABOVE 10%.
  if (feedRecipients.some(r => r.type === 'wavlake')) {
    const WAVLAKE_BUILTIN_PR_PERCENT = 10; // 5% PR + 5% Wavlake fee baked in via appId
    const extraPR = prSplitPercent - WAVLAKE_BUILTIN_PR_PERCENT;
    if (extraPR <= 0) return feedRecipients; // user's split ≤ 10% — already covered

    // Scale the wavlake recipient down by extraPR%, add PR for the remainder
    const wavlakeShare = 100 - extraPR;
    const scaled = feedRecipients.map(r => ({
      ...r,
      split: Math.round((r.split / 100) * wavlakeShare),
    }));
    return [
      ...scaled,
      { name: 'Personal Radio', type: 'lnaddress' as const, address: PR_LIGHTNING_ADDRESS, split: extraPR },
    ];
  }

  const artistsShare  = 100 - prSplitPercent;
  const totalShares   = feedRecipients.reduce((s, r) => s + r.split, 0);
  if (totalShares === 0) return feedRecipients;

  const scaled = feedRecipients.map(r => ({
    ...r,
    split: Math.round((r.split / totalShares) * artistsShare),
  }));

  return [
    ...scaled,
    { name: 'Personal Radio', type: 'lnaddress' as const, address: PR_LIGHTNING_ADDRESS, split: prSplitPercent },
  ];
}

/**
 * Add sats to the cross-song payment buffer.
 */
function accumulateToBuffer(
  buffer: Map<string, PendingPayment>,
  recipients: ValueRecipient[],
  satsThisMinute: number,
) {
  const totalShares = recipients.reduce((s, r) => s + r.split, 0);
  if (totalShares === 0) return;

  for (const r of recipients) {
    const share = r.split / totalShares;
    const sats  = Math.round(satsThisMinute * share);
    if (sats <= 0) continue;

    const existing = buffer.get(r.address);
    if (existing) {
      existing.accumulatedSats += sats;
      if (existing.accumulatedSats > MAX_PENDING_SATS) {
        console.log(`[V4V] dropped ${existing.accumulatedSats} pending sats for "${r.name}" — payment cap exceeded`);
        existing.accumulatedSats = 0;
      }
    } else {
      buffer.set(r.address, {
        recipientName:     r.name,
        recipientType:     r.type,
        address:           r.address,
        splitPercent:      Math.round(share * 100),
        accumulatedSats:   sats,
        customRecords:     r.customRecords,
        firstAccumulatedAt: Date.now(),
      });
    }
  }
}

// ── LNURL helpers (lightning address → invoice) ───────────────────────────────

/**
 * Resolve a lightning address to a BOLT11 invoice via LNURL-pay.
 * Uses /podcast-proxy?action=lnurl as CORS proxy.
 */
async function fetchInvoiceForLnAddress(address: string, amountSats: number): Promise<string> {
  const [user, domain] = address.split('@');
  if (!user || !domain) throw new Error(`Invalid lightning address: ${address}`);

  const lnurlEndpoint = `https://${domain}/.well-known/lnurlp/${user}`;
  const proxyBase     = '/.netlify/functions/podcast-proxy?action=lnurl&url=';

  // Step 1 — fetch LNURL-pay metadata
  const metaRes = await fetch(`${proxyBase}${encodeURIComponent(lnurlEndpoint)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!metaRes.ok) throw new Error(`LNURL metadata fetch failed: HTTP ${metaRes.status}`);
  const meta = await metaRes.json() as { callback: string; minSendable: number; maxSendable: number };

  const amountMsats = amountSats * 1000;
  if (amountMsats < meta.minSendable || amountMsats > meta.maxSendable) {
    throw new Error(`Amount ${amountSats} sats out of range [${meta.minSendable / 1000}–${meta.maxSendable / 1000}]`);
  }

  // Step 2 — fetch invoice
  const callbackUrl = `${meta.callback}${meta.callback.includes('?') ? '&' : '?'}amount=${amountMsats}`;
  const invoiceRes  = await fetch(`${proxyBase}${encodeURIComponent(callbackUrl)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!invoiceRes.ok) throw new Error(`LNURL invoice fetch failed: HTTP ${invoiceRes.status}`);
  const invoiceData = await invoiceRes.json() as { pr?: string; reason?: string };
  if (!invoiceData.pr) throw new Error(`No invoice in LNURL response: ${invoiceData.reason ?? 'unknown'}`);

  return invoiceData.pr;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useV4V() {
  // ── Persisted settings ─────────────────────────────────────────────────────
  const [connectionString, setConnectionString] = useState<string | null>(() =>
    localStorage.getItem(NWC_CONN_KEY),
  );
  const [satRatePerMinute, setSatRatePerMinuteState] = useState<number>(() =>
    parseInt(localStorage.getItem(NWC_SAT_RATE_KEY) ?? '10', 10) || 10,
  );
  const [supportPREnabled, setSupportPREnabledState] = useState<boolean>(() =>
    localStorage.getItem(NWC_SUPPORT_PR_KEY) === 'true',
  );
  const [prSplitPercent, setPRSplitPercentState] = useState<number>(() =>
    parseInt(localStorage.getItem(NWC_PR_SPLIT_KEY) ?? '20', 10) || 20,
  );

  // ── Connection state ───────────────────────────────────────────────────────
  const [isConnected,   setIsConnected]   = useState(false);
  const [isConnecting,  setIsConnecting]  = useState(false);
  const [walletAlias,   setWalletAlias]   = useState<string | null>(null);
  const [capabilities,  setCapabilities]  = useState<string[]>([]);
  const [connectError,  setConnectError]  = useState<string | null>(null);

  // ── Streaming state ────────────────────────────────────────────────────────
  const [isStreaming,        setIsStreaming]        = useState(false);
  const [totalSentThisSession, setTotalSent]        = useState(0);
  const [pendingTotal,       setPendingTotal]       = useState(0);
  const [lastFlushResult,    setLastFlushResult]    = useState<FlushResult | null>(null);
  const [hasPaymentErrors,   setHasPaymentErrors]  = useState(false);

  // ── Refs (mutable, not reactive) ───────────────────────────────────────────
  const nwcClientRef       = useRef<import('@getalby/sdk').webln.NWC | null>(null);
  const bufferRef          = useRef<Map<string, PendingPayment>>(loadBuffer());
  const currentRecipientsRef = useRef<ValueRecipient[]>([]);
  const currentMetaRef     = useRef<ItemMeta | null>(null);
  const secondsAccRef      = useRef(0);          // seconds since last accumulation
  const streamIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const flushIntervalRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const pauseTimerRef      = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const senderIdRef        = useRef(getOrCreateSenderId());
  const satRateRef         = useRef(satRatePerMinute);
  const supportPRRef       = useRef(supportPREnabled);
  const prSplitRef         = useRef(prSplitPercent);
  const failureCountRef    = useRef<Map<string, number>>(new Map());
  const disabledRef        = useRef<Set<string>>(new Set());

  // Keep refs in sync with state (so callbacks don't need to re-register)
  useEffect(() => { satRateRef.current   = satRatePerMinute; }, [satRatePerMinute]);
  useEffect(() => { supportPRRef.current = supportPREnabled;  }, [supportPREnabled]);
  useEffect(() => { prSplitRef.current   = prSplitPercent;    }, [prSplitPercent]);

  // ── Flush logic ────────────────────────────────────────────────────────────

  const flushPendingPayments = useCallback(async (reason?: string): Promise<FlushResult> => {
    const client = nwcClientRef.current;
    const buf    = bufferRef.current;
    const result: FlushResult = { sent: 0, payments: 0, errors: [], timestamp: Date.now() };

    if (!client || buf.size === 0) return result;

    if (reason) console.log(`[V4V] flush triggered — reason: "${reason}"`);

    // Health check — if the wallet is unreachable, skip the entire flush
    try {
      await (client as unknown as { getBalance: () => Promise<unknown> }).getBalance();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes('reply timeout') || msg.toLowerCase().includes('timed out')) {
        console.warn('[V4V] NWC wallet unreachable — skipping flush');
        setHasPaymentErrors(true);
        return result;
      }
      // Non-timeout errors from getBalance are non-fatal (wallet may not support it)
    }

    const now          = Date.now();
    const senderId     = senderIdRef.current;
    const currentMeta  = currentMetaRef.current;

    const keysendBatch: { address: string; entry: PendingPayment }[] = [];
    const invoiceBatch: { address: string; entry: PendingPayment }[] = [];
    const wavlakeBatch: { address: string; entry: PendingPayment }[] = [];

    for (const [address, entry] of buf.entries()) {
      if (disabledRef.current.has(address)) {
        console.log(`[V4V] skipping disabled recipient "${entry.recipientName}"`);
        continue;
      }
      const overThreshold = entry.accumulatedSats >= MIN_FLUSH_SATS;
      const isStale       = (now - entry.firstAccumulatedAt) >= MAX_BUFFER_AGE_MS;
      if (!overThreshold && !isStale) {
        if (entry.accumulatedSats > 0) {
          console.log(`[V4V] skipping "${entry.recipientName}" — only ${entry.accumulatedSats} sats (below 10 sat threshold)`);
        }
        continue;
      }
      if (entry.accumulatedSats <= 0) continue;

      if (entry.recipientType === 'node') {
        keysendBatch.push({ address, entry });
      } else if (entry.recipientType === 'wavlake') {
        wavlakeBatch.push({ address, entry });
      } else {
        invoiceBatch.push({ address, entry });
      }
    }

    const allBatches = [...keysendBatch, ...invoiceBatch, ...wavlakeBatch];
    console.log(`[V4V] flush — ${allBatches.length} recipients, total: ${allBatches.reduce((s, { entry }) => s + entry.accumulatedSats, 0)} sats`);

    // TLV stream metadata (bLIP-10, type 7629169)
    const streamMeta = currentMeta ? {
      podcast:      currentMeta.feedTitle,
      feedID:       currentMeta.feedId,
      episode:      currentMeta.isEpisode ? currentMeta.itemTitle : undefined,
      itemID:       undefined as number | undefined,
      action:       'stream' as const,
      ts:           Math.floor(now / 1000),
      app_name:     'Personal Radio' as const,
      app_version:  '1.0',
      seconds_back: secondsAccRef.current,
      speed:        '1',
      sender_id:    senderId,
    } : null;

    const tlvHex = streamMeta
      ? Buffer.from(JSON.stringify(streamMeta)).toString('hex')
      : null;

    // ── Keysend payments ─────────────────────────────────────────────────────
    // Use multi_pay_keysend if supported, otherwise individual keysends
    const supportsMulti = capabilities.includes('multi_pay_keysend');

    if (keysendBatch.length > 0) {
      if (supportsMulti && keysendBatch.length > 1) {
        // Batch all keysends into one NWC request
        try {
          const keysends = keysendBatch.map(({ address, entry }) => ({
            pubkey:     address,
            amount:     entry.accumulatedSats,
            tlv_records: tlvHex ? [{ type: 7629169, value: tlvHex }] : [],
          }));
          for (const { entry } of keysendBatch) {
            console.log(`[V4V] paying "${entry.recipientName}" — ${entry.accumulatedSats} sats via keysend`);
          }
          await (client as unknown as { multiKeysend: (p: unknown) => Promise<void> })
            .multiKeysend({ keysends });
          for (const { address, entry } of keysendBatch) {
            console.log(`[V4V] ✅ paid "${entry.recipientName}" — ${entry.accumulatedSats} sats`);
            result.sent     += entry.accumulatedSats;
            result.payments += 1;
            buf.get(address)!.accumulatedSats = 0;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          for (const { entry } of keysendBatch) {
            console.log(`[V4V] ❌ failed "${entry.recipientName}" — ${msg}`);
          }
          result.errors.push(`multi_pay_keysend failed: ${msg}`);
        }
      } else {
        // Individual keysend per recipient
        for (const { address, entry } of keysendBatch) {
          console.log(`[V4V] paying "${entry.recipientName}" — ${entry.accumulatedSats} sats via keysend`);
          try {
            await withRetry(() => client.keysend({
              destination: address,
              amount:      entry.accumulatedSats,
              customRecords: {
                ...(tlvHex ? { '7629169': tlvHex } : {}),
                ...(entry.customRecords ?? {}),
              },
            }), 2, entry.recipientName);
            console.log(`[V4V] ✅ paid "${entry.recipientName}" — ${entry.accumulatedSats} sats`);
            result.sent     += entry.accumulatedSats;
            result.payments += 1;
            buf.get(address)!.accumulatedSats = 0;
            failureCountRef.current.delete(address);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`[V4V] ❌ failed "${entry.recipientName}" — ${msg}`);
            result.errors.push(`keysend to ${entry.recipientName} failed: ${msg}`);
            const count = (failureCountRef.current.get(address) ?? 0) + 1;
            failureCountRef.current.set(address, count);
            if (count >= MAX_CONSEC_FAILURES) {
              disabledRef.current.add(address);
              console.warn(`[V4V] disabled payments to "${entry.recipientName}" — too many failures`);
            }
          }
        }
      }
    }

    // ── Invoice payments (lnaddress via LNURL) ───────────────────────────────
    for (const { address, entry } of invoiceBatch) {
      console.log(`[V4V] paying "${entry.recipientName}" — ${entry.accumulatedSats} sats via lnaddress`);
      try {
        // Fetch a fresh invoice on each attempt (invoices expire, can't reuse).
        await withRetry(async () => {
          const invoice = await fetchInvoiceForLnAddress(address, entry.accumulatedSats);
          await client.sendPayment(invoice);
        }, 2, entry.recipientName);
        console.log(`[V4V] ✅ paid "${entry.recipientName}" — ${entry.accumulatedSats} sats`);
        result.sent     += entry.accumulatedSats;
        result.payments += 1;
        buf.get(address)!.accumulatedSats = 0;
        failureCountRef.current.delete(address);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`[V4V] ❌ failed "${entry.recipientName}" — ${msg}`);
        result.errors.push(`lnaddress payment to ${entry.recipientName} failed: ${msg}`);
        const count = (failureCountRef.current.get(address) ?? 0) + 1;
        failureCountRef.current.set(address, count);
        if (count >= MAX_CONSEC_FAILURES) {
          disabledRef.current.add(address);
          console.warn(`[V4V] disabled payments to "${entry.recipientName}" — too many failures`);
        }
      }
    }

    // ── Wavlake payments (LNURL primary → keysend fallback) ──────────────────
    for (const { address: trackId, entry } of wavlakeBatch) {
      console.log(`[V4V] paying "${entry.recipientName}" — ${entry.accumulatedSats} sats via Wavlake`);
      let paid = false;

      // Primary: LNURL invoice via server-side proxy (includes appId=personal-radio split)
      try {
        const amountMsats = entry.accumulatedSats * 1000;
        const proxyRes = await fetch(
          `/.netlify/functions/wavlake-pay?contentId=${encodeURIComponent(trackId)}&amountMsats=${amountMsats}`,
          { signal: AbortSignal.timeout(30_000) },
        );
        if (!proxyRes.ok) throw new Error(`wavlake-pay HTTP ${proxyRes.status}`);
        const proxyData = await proxyRes.json() as { pr?: string; below_minimum?: boolean; minSendableSats?: number; error?: string };

        if (proxyData.below_minimum) {
          console.log(`[V4V] buffering ${entry.accumulatedSats} sats for "${entry.recipientName}" — below Wavlake minimum (${proxyData.minSendableSats} sats)`);
          paid = true; // carry forward, no fallback needed
        } else if (proxyData.pr) {
          await client.sendPayment(proxyData.pr);
          console.log(`[V4V] ✅ paid ${entry.accumulatedSats} sats for "${entry.recipientName}" via Wavlake LNURL`);
          result.sent     += entry.accumulatedSats;
          result.payments += 1;
          buf.get(trackId)!.accumulatedSats = 0;
          failureCountRef.current.delete(trackId);
          paid = true;
        } else {
          throw new Error(proxyData.error ?? 'No invoice from wavlake-pay');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`[Wavlake] LNURL failed for "${entry.recipientName}" — ${msg} — trying keysend fallback`);
      }

      // Fallback: direct keysend to Wavlake's Lightning node
      if (!paid) {
        const customValueHex = Array.from(new TextEncoder().encode(trackId))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        try {
          await withRetry(() => client.keysend({
            destination: WAVLAKE_LN_NODE,
            amount:      entry.accumulatedSats,
            customRecords: {
              [WAVLAKE_CUSTOM_KEY]: customValueHex,
              ...(tlvHex ? { '7629169': tlvHex } : {}),
            },
          }), 2, entry.recipientName);
          console.log(`[V4V] ✅ paid ${entry.accumulatedSats} sats for "${entry.recipientName}" via keysend fallback`);
          result.sent     += entry.accumulatedSats;
          result.payments += 1;
          buf.get(trackId)!.accumulatedSats = 0;
          failureCountRef.current.delete(trackId);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.log(`[V4V] ❌ failed "${entry.recipientName}" — ${msg}`);
          result.errors.push(`Wavlake payment to ${entry.recipientName} failed: ${msg}`);
          const count = (failureCountRef.current.get(trackId) ?? 0) + 1;
          failureCountRef.current.set(trackId, count);
          if (count >= MAX_CONSEC_FAILURES) {
            disabledRef.current.add(trackId);
            console.warn(`[V4V] disabled payments to "${entry.recipientName}" — too many failures`);
          }
        }
      }
    }

    // Persist updated buffer (amounts zeroed, entries kept for future accumulation)
    saveBuffer(buf);

    if (result.sent > 0) {
      setTotalSent(prev => {
        const newTotal = prev + result.sent;
        console.log(`[V4V] session total: ${newTotal} sats sent`);
        return newTotal;
      });
    }
    if (result.errors.length > 0) {
      console.warn('[V4V] flush errors:', result.errors);
      setHasPaymentErrors(true);
    } else if (result.payments > 0) {
      setHasPaymentErrors(false);
    }

    // Recompute pending total
    const newPending = [...buf.values()].reduce((s, e) => s + e.accumulatedSats, 0);
    setPendingTotal(newPending);

    setLastFlushResult(result);
    return result;
  }, [capabilities]);

  // ── Connection ─────────────────────────────────────────────────────────────

  const connect = useCallback(async (connString: string): Promise<boolean> => {
    setIsConnecting(true);
    setConnectError(null);
    try {
      const { webln } = await import('@getalby/sdk');
      // Default replyTimeout is 10 s — far too short for Lightning routing plus
      // LNURL resolution (which itself takes up to 20 s). Use 120 s.
      const client = new webln.NWC({ nostrWalletConnectUrl: connString, replyTimeout: 120_000 });
      await client.enable();

      // Fetch wallet info / capabilities
      let detectedMethods: string[] = [];
      try {
        const info = await client.getInfo();
        setWalletAlias(info.node?.alias ?? null);
        detectedMethods = (info as unknown as { methods?: string[] }).methods ?? [];
        setCapabilities(detectedMethods);
      } catch {
        // Non-fatal — not all wallets support get_info
        detectedMethods = ['pay_invoice', 'pay_keysend'];
        setCapabilities(detectedMethods);
      }

      nwcClientRef.current = client;
      setConnectionString(connString);
      localStorage.setItem(NWC_CONN_KEY, connString);
      setIsConnected(true);
      setIsConnecting(false);
      console.log(`[V4V] connected — wallet capabilities: ${detectedMethods.join(', ')}`);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setConnectError(msg);
      setIsConnected(false);
      setIsConnecting(false);
      console.error('[V4V] NWC connect failed:', msg);
      return false;
    }
  }, []);

  const disconnect = useCallback(() => {
    nwcClientRef.current = null;
    setIsConnected(false);
    setConnectionString(null);
    setWalletAlias(null);
    setCapabilities([]);
    localStorage.removeItem(NWC_CONN_KEY);
    stopStreaming();
    console.log('[V4V] disconnected');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-reconnect on mount if a stored connection string exists
  useEffect(() => {
    const stored = localStorage.getItem(NWC_CONN_KEY);
    if (stored && !nwcClientRef.current) {
      connect(stored).catch(() => {/* silent — user can reconnect manually */});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Streaming ──────────────────────────────────────────────────────────────

  const stopStreaming = useCallback(() => {
    if (streamIntervalRef.current) { clearInterval(streamIntervalRef.current); streamIntervalRef.current = null; }
    setIsStreaming(false);
    console.log('[V4V] streaming stopped');
  }, []);

  const startStreaming = useCallback((valueTag: ValueTag | undefined, meta: ItemMeta) => {
    if (!nwcClientRef.current) return;

    // Stop any previous stream timer (track change)
    if (streamIntervalRef.current) clearInterval(streamIntervalRef.current);

    const recipients = buildRecipients(
      valueTag?.recipients ?? [],
      supportPRRef.current,
      prSplitRef.current,
    );
    currentRecipientsRef.current = recipients;
    currentMetaRef.current       = meta;
    secondsAccRef.current        = 0;

    if (recipients.length === 0) {
      setIsStreaming(false);
      return;
    }

    setIsStreaming(true);

    console.log(`[V4V] streaming started — item: "${meta.itemTitle}" recipients: ${recipients.length} rate: ${satRateRef.current} sats/min`);

    // Every second: increment counter; every 60 s: accumulate sats into buffer
    streamIntervalRef.current = setInterval(() => {
      secondsAccRef.current += 1;
      if (secondsAccRef.current % 60 === 0) {
        const satsThisMinute = satRateRef.current;
        const recs = currentRecipientsRef.current;
        const totalShares = recs.reduce((s, r) => s + r.split, 0);
        accumulateToBuffer(bufferRef.current, recs, satsThisMinute);
        saveBuffer(bufferRef.current);
        const bufTotal = [...bufferRef.current.values()].reduce((s, e) => s + e.accumulatedSats, 0);
        setPendingTotal(bufTotal);
        if (totalShares > 0) {
          for (const r of recs) {
            const sats = Math.round(satsThisMinute * (r.split / totalShares));
            if (sats > 0) {
              const entry = bufferRef.current.get(r.address);
              console.log(`[V4V] tick — accumulated ${sats} sats for "${r.name}" (total: ${entry?.accumulatedSats ?? sats})`);
            }
          }
        }
      }
    }, 1000);
  }, []);

  /** Call on track change — does NOT flush, just swaps recipients */
  const onTrackChange = useCallback((valueTag: ValueTag | undefined, meta: ItemMeta) => {
    const recipients = buildRecipients(
      valueTag?.recipients ?? [],
      supportPRRef.current,
      prSplitRef.current,
    );
    currentRecipientsRef.current = recipients;
    currentMetaRef.current       = meta;
    console.log(`[V4V] track changed → "${meta.itemTitle}" (${recipients.length} recipients, no flush)`);
  }, []);

  /** Call when playback pauses */
  const onPause = useCallback(() => {
    stopStreaming();
    pauseTimerRef.current = setTimeout(() => {
      flushPendingPayments('pause');
    }, PAUSE_FLUSH_MS);
  }, [flushPendingPayments, stopStreaming]);

  /** Call when playback resumes */
  const onPlay = useCallback((valueTag: ValueTag | undefined, meta: ItemMeta) => {
    if (pauseTimerRef.current) { clearTimeout(pauseTimerRef.current); pauseTimerRef.current = null; }
    startStreaming(valueTag, meta);
  }, [startStreaming]);

  // ── 15-minute periodic flush ───────────────────────────────────────────────
  useEffect(() => {
    if (!isConnected) return;
    flushIntervalRef.current = setInterval(() => { flushPendingPayments('interval'); }, FLUSH_INTERVAL_MS);
    return () => { if (flushIntervalRef.current) clearInterval(flushIntervalRef.current); };
  }, [isConnected, flushPendingPayments]);

  // ── Tab close / visibility change ─────────────────────────────────────────
  useEffect(() => {
    const onBeforeUnload = () => { flushPendingPayments('close'); };
    const onVisibility   = () => { if (document.visibilityState === 'hidden') flushPendingPayments('close'); };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flushPendingPayments]);

  // ── Settings setters (persist immediately) ────────────────────────────────
  const setSatRatePerMinute = useCallback((rate: number) => {
    const clamped = Math.max(1, Math.min(100, rate));
    setSatRatePerMinuteState(clamped);
    localStorage.setItem(NWC_SAT_RATE_KEY, String(clamped));
  }, []);

  const setSupportPREnabled = useCallback((enabled: boolean) => {
    setSupportPREnabledState(enabled);
    localStorage.setItem(NWC_SUPPORT_PR_KEY, String(enabled));
  }, []);

  const setPRSplitPercent = useCallback((percent: number) => {
    const clamped = Math.max(0, Math.min(100, percent));
    setPRSplitPercentState(clamped);
    localStorage.setItem(NWC_PR_SPLIT_KEY, String(clamped));
  }, []);

  return {
    // Connection
    connect,
    disconnect,
    isConnected,
    isConnecting,
    walletAlias,
    capabilities,
    connectError,
    connectionString,

    // Streaming control
    startStreaming,
    stopStreaming,
    onTrackChange,
    onPlay,
    onPause,
    isStreaming,

    // Settings
    satRatePerMinute,
    setSatRatePerMinute,
    supportPREnabled,
    setSupportPREnabled,
    prSplitPercent,
    setPRSplitPercent,

    // Status
    pendingTotal,
    totalSentThisSession,
    lastFlushResult,
    hasPaymentErrors,
    flushPendingPayments,
  };
}

export type V4VContextValue = ReturnType<typeof useV4V>;
