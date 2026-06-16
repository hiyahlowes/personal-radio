import { describe, expect, it } from 'vitest';
import { shouldUseViaModeration } from './claude-proxy.mjs';

describe('claude-proxy Via radio moderation', () => {
  it('detects radio moderation requests only when enabled', () => {
    expect(shouldUseViaModeration({ purpose: 'radio-moderation' }, { PERSONAL_RADIO_USE_VIA: 'true' })).toBe(true);
    expect(shouldUseViaModeration({ purpose: 'other' }, { PERSONAL_RADIO_USE_VIA: 'true' })).toBe(false);
    expect(shouldUseViaModeration({ purpose: 'radio-moderation' }, { PERSONAL_RADIO_USE_VIA: 'false' })).toBe(false);
  });

});
