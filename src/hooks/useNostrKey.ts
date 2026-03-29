/**
 * useNostrKey
 *
 * Generates (or loads) a stable Nostr keypair for this PR instance.
 * The nsec is persisted to localStorage so it survives page reloads.
 * The keypair is used to sign NIP-90 job requests.
 */

import { useMemo } from 'react';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { nip19 } from 'nostr-tools';

export interface NostrKey {
  /** Bech32-encoded secret key: "nsec1…" */
  nsec: string;
  /** Bech32-encoded public key: "npub1…" */
  npub: string;
  /** Hex-encoded public key (used in Nostr event tags and NIP-04). */
  publicKey: string;
  /** Raw 32-byte private key (used for signing and NIP-04). */
  privateKey: Uint8Array;
}

const STORAGE_KEY = 'pr:nostr-nsec';

export function useNostrKey(): NostrKey {
  return useMemo(() => {
    // ── Try to load existing keypair ───────────────────────────────────────
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const decoded = nip19.decode(stored);
        if (decoded.type === 'nsec') {
          const privateKey = decoded.data;
          const publicKey  = getPublicKey(privateKey);
          const npub       = nip19.npubEncode(publicKey);
          console.log('[Nostr] loaded existing keypair:', npub);
          return { nsec: stored, npub, publicKey, privateKey };
        }
      }
    } catch { /* fall through to generate */ }

    // ── Generate a fresh keypair ───────────────────────────────────────────
    const privateKey = generateSecretKey();
    const nsec       = nip19.nsecEncode(privateKey);
    const publicKey  = getPublicKey(privateKey);
    const npub       = nip19.npubEncode(publicKey);
    localStorage.setItem(STORAGE_KEY, nsec);
    console.log('[Nostr] generated new keypair:', npub);
    return { nsec, npub, publicKey, privateKey };
  }, []);
}
