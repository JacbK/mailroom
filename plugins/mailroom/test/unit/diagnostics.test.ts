import { describe, expect, it } from 'vitest';
import { doctorJson, doctorText, type DoctorReport } from '../../src/diagnostics.js';

const unhealthy: DoctorReport = {
  node: { version: '21.0.0', ok: false },
  platform: { value: 'darwin', ok: true },
  oauth_client: { ok: true, mode: 'shared' },
  account_count: 2,
  accounts: [
    { alias: 'personal', email: 'private@example.com', status: 'connected' },
    { alias: 'work', email: 'secret@company.example', status: 'needs_auth' },
  ],
  ok: false,
};

describe('doctor diagnostics', () => {
  it('redacts emails from text and JSON without hiding recovery steps', () => {
    const text = doctorText(unhealthy, true);
    const json = JSON.stringify(doctorJson(unhealthy, true));

    expect(text).toContain('account-2: needs_auth');
    expect(text).toContain('./mailroom auth reauth <alias for account-2>');
    expect(text).not.toContain('personal');
    expect(json).not.toContain('work');
    expect(text).not.toContain('private@example.com');
    expect(json).not.toContain('secret@company.example');
  });

  it('removes OAuth client details from shareable JSON', () => {
    const report: DoctorReport = {
      ...unhealthy,
      oauth_client: {
        ok: true,
        mode: 'self-hosted',
        fingerprint: 'private-client-fingerprint',
        source: '/Users/private/google-oauth.json',
      },
    };

    expect(doctorJson(report, true)).toMatchObject({
      oauth_client: { ok: true, mode: 'self-hosted' },
    });
    expect(JSON.stringify(doctorJson(report, true))).not.toContain('private-client-fingerprint');
    expect(JSON.stringify(doctorJson(report, true))).not.toContain('/Users/private');
  });

  it('keeps local account context in normal diagnostics', () => {
    expect(doctorText(unhealthy, false)).toContain('personal (private@example.com): connected');
    expect(JSON.stringify(doctorJson(unhealthy, false))).toContain('secret@company.example');
  });

  it('explains platform, OAuth, empty-account, and transient failures', () => {
    const report: DoctorReport = {
      node: { version: '24.0.0', ok: true },
      platform: { value: 'linux', ok: false },
      oauth_client: { ok: false, mode: null },
      account_count: 1,
      accounts: [{ alias: 'work', email: 'work@example.com', status: 'error' }],
      ok: false,
    };
    const text = doctorText(report, false);

    expect(text).toContain('Run Mailroom on macOS');
    expect(text).toContain('Run ./setup --personal');
    expect(text).toContain('if work still fails');

    const empty = doctorText({ ...report, accounts: [], account_count: 0 }, true);
    expect(empty).toContain('./setup --account alias=you@example.com');
  });

  it('keeps a healthy self-hosted report concise', () => {
    const report: DoctorReport = {
      node: { version: '24.0.0', ok: true },
      platform: { value: 'darwin', ok: true },
      oauth_client: { ok: true, mode: 'self-hosted' },
      account_count: 1,
      accounts: [{ alias: 'work', email: 'work@example.com', status: 'connected' }],
      ok: true,
    };

    const text = doctorText(report, false);
    expect(text).toContain('Google OAuth: personal app');
    expect(text).toContain('Overall: healthy');
    expect(text).not.toContain('Next:');
  });
});
