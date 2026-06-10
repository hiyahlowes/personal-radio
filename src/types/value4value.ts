// ── Value4Value types (Podcast 2.0 / Lightning / NWC) ────────────────────────

export interface ValueRecipient {
  name: string;
  type: 'node' | 'lnaddress' | 'wavlake';
  address: string;   // node pubkey (hex), lightning address (user@domain), or Wavlake trackId (UUID)
  split: number;     // integer share weight (not a percentage)
  customRecords?: Record<string, string>;
  fee?: boolean;     // true = app-fee recipient (e.g. hosting provider)
}

export interface ValueTag {
  type: 'lightning';
  method: 'keysend' | 'split' | 'paywall';
  suggested?: number;          // suggested sats/min from feed
  recipients: ValueRecipient[];
}

export interface ItemMeta {
  itemId: string;
  itemTitle: string;
  feedTitle: string;
  feedId?: number;
  isEpisode: boolean;  // false = music track
}

export interface PendingPayment {
  recipientName: string;
  recipientType: 'node' | 'lnaddress' | 'wavlake';
  address: string;
  splitPercent: number;        // normalized percentage of this flush's total
  accumulatedSats: number;
  customRecords?: Record<string, string>;
  firstAccumulatedAt: number;  // unix ms — for max-age threshold
}

export interface FlushResult {
  sent: number;        // total sats sent in this flush
  payments: number;    // number of individual payments
  errors: string[];    // any payment-level error messages
  timestamp: number;
}
