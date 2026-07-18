import { describe, expect, it, vi } from 'vitest';
import { isRetryableGoogleError, withRetry } from '../../src/gmail/retry.js';

describe('Google retry policy', () => {
  it.each([408, 429, 500, 503])('retries status %s', (status) => {
    expect(isRetryableGoogleError({ response: { status } })).toBe(true);
  });

  it.each([400, 401, 403, 404])('does not retry status %s', (status) => {
    expect(isRetryableGoogleError({ response: { status } })).toBe(false);
  });

  it('backs off and eventually succeeds', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce({ code: 429 })
      .mockRejectedValueOnce({ code: 503 })
      .mockResolvedValue('ok');
    const sleep = vi.fn(async () => undefined);
    await expect(withRetry(operation, { sleep, baseDelayMs: 1 })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
