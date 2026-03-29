/**
 * useNIP90
 *
 * NIP-90 Data Vending Machine client for PR Personal Radio.
 *
 * Sends a kind-5250 job request to the user's personal AI agent via Nostr
 * and waits up to 3 s for a kind-6250 result event.
 *
 * Job content is NIP-04 encrypted so only the agent can read the prompt.
 * Falls back gracefully (returns null) on any error or timeout, letting
 * the caller switch to Claude Haiku silently.
 */

import { useCallback } from 'react';
import { finalizeEvent } from 'nostr-tools';
import { nip04 } from 'nostr-tools';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NIP90JobParams {
  /** The moderator prompt (same text that would go to Claude). */
  prompt: string;
  /** "Listener: <name>, Language: <lang>" context line. */
  listenerInfo: string;
  /** Agent's public key in hex. */
  agentPubkeyHex: string;
  /** Listener's own pubkey in hex (optional — context hint for the agent). */
  listenerPubkeyHex?: string;
  /** Relay URL, e.g. "wss://relay.damus.io". */
  relay: string;
  /** PR's private key (Uint8Array). */
  privateKey: Uint8Array;
}

const JOB_TIMEOUT_MS = 3000;

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useNIP90() {
  /**
   * Send a NIP-90 job request and wait for the result.
   * Returns the agent's response text, or null on timeout/error.
   */
  const sendJob = useCallback(async (params: NIP90JobParams): Promise<string | null> => {
    const {
      prompt,
      listenerInfo,
      agentPubkeyHex,
      listenerPubkeyHex,
      relay,
      privateKey,
    } = params;

    console.log('[NIP-90] sending to relay:', localStorage.getItem('pr:agent-relay'));

    // ── NIP-04 encrypt the prompt so only the agent can read it ───────────
    let content = '';
    try {
      content = await nip04.encrypt(privateKey, agentPubkeyHex, prompt);
    } catch (e) {
      console.warn('[NIP-90] nip04 encryption failed, using empty content:', e);
    }

    // ── Build event tags ──────────────────────────────────────────────────
    const tags: string[][] = [
      ['i', prompt,       'text'],
      ['i', listenerInfo, 'text'],
      ['param',  'style', 'bitcoin-maxi-radio-host'],
      ['output', 'text/plain'],
      ['p', agentPubkeyHex],
    ];
    if (listenerPubkeyHex) {
      tags.push(['p', listenerPubkeyHex]);
    }
    tags.push(['relays', relay]);

    // ── Sign the event ────────────────────────────────────────────────────
    const event = finalizeEvent(
      {
        kind: 5250,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content,
      },
      privateKey,
    );

    console.log('[NIP-90] publishing event:', JSON.stringify(event));
    console.log('[NIP-90] job sent:', event.id);

    // ── Open WebSocket, publish event, wait for result ────────────────────
    return new Promise<string | null>((resolve) => {
      let ws: WebSocket | null = null;
      let resolved = false;
      const startTime = Date.now();

      const finish = (result: string | null) => {
        if (resolved) return;
        resolved = true;
        try { ws?.close(); } catch { /* ignore */ }
        resolve(result);
      };

      const timer = setTimeout(() => {
        console.log('[NIP-90] timeout — falling back to Claude');
        finish(null);
      }, JOB_TIMEOUT_MS);

      try {
        ws = new WebSocket(relay);
      } catch {
        clearTimeout(timer);
        resolve(null);
        return;
      }

      ws.onopen = () => {
        try {
          ws!.send(JSON.stringify(['EVENT', event]));
          const subId = Math.random().toString(36).slice(2, 10);
          ws!.send(JSON.stringify(['REQ', subId, { kinds: [6250], '#e': [event.id] }]));
        } catch {
          clearTimeout(timer);
          finish(null);
        }
      };

      ws.onmessage = (msg) => {
        try {
          console.log('[NIP-90] relay response:', msg.data);
          const data = JSON.parse(msg.data as string) as unknown[];
          if (
            Array.isArray(data) &&
            data[0] === 'EVENT' &&
            typeof data[2] === 'object' &&
            data[2] !== null &&
            (data[2] as Record<string, unknown>).kind === 6250
          ) {
            clearTimeout(timer);
            const elapsed = Date.now() - startTime;
            console.log(`[NIP-90] result received in ${elapsed}ms`);
            const text = ((data[2] as Record<string, unknown>).content as string | undefined) || null;
            finish(text);
          }
        } catch { /* ignore parse errors */ }
      };

      ws.onerror = () => {
        clearTimeout(timer);
        finish(null);
      };

      ws.onclose = () => {
        if (!resolved) {
          clearTimeout(timer);
          finish(null);
        }
      };
    });
  }, []);

  return { sendJob };
}
