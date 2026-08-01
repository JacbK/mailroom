import { describe, expect, it } from 'vitest';
import { MailroomError } from '../../src/errors.js';
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

  it('includes safe recovery guidance for Mailroom errors', () => {
    const error = new MailroomError(
      'AUTH_REQUIRED',
      'Google sign-in failed.',
      'Run `./setup --reauth`.',
    );
    expect(safeDiagnostic(error)).toBe(
      'MailroomError: Google sign-in failed.\nRecovery: Run `./setup --reauth`.',
    );
  });
});
