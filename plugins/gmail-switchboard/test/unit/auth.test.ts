import { describe, expect, it } from 'vitest';
import { assertExpectedIdentity } from '../../src/auth/oauth.js';
import type { SwitchboardError } from '../../src/errors.js';

describe('OAuth identity verification', () => {
  it('normalizes and accepts the exact expected identity', () => {
    expect(assertExpectedIdentity('Jacob@Embrasure.ai', 'jacob@embrasure.ai'))
      .toBe('jacob@embrasure.ai');
  });

  it('rejects the wrong Google account before credentials are saved', () => {
    expect(() => assertExpectedIdentity('wrong@gmail.com', 'jacob@embrasure.ai'))
      .toThrow(expect.objectContaining<Partial<SwitchboardError>>({ code: 'WRONG_ACCOUNT' }));
  });
});
