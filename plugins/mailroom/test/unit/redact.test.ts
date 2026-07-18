import { describe, expect, it } from 'vitest';
import { redact, safeDiagnostic } from '../../src/security/redact.js';

describe('diagnostic redaction', () => {
  it('removes bearer tokens and Google access tokens', () => {
    expect(redact('Authorization: Bearer secret-token')).not.toContain('secret-token');
    expect(redact(['ya29', 'abcdefghijklmnopqrstuvwxyz_1234567890'].join('.'))).not.toContain('ya29.');
  });

  it('does not serialize arbitrary error objects', () => {
    const error = Object.assign(new Error('request failed'), { response: { body: 'private email' } });
    expect(safeDiagnostic(error)).toBe('Error: request failed');
  });
});
