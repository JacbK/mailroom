import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertExpectedIdentity, AuthManager } from '../../src/auth/oauth.js';
import type { SwitchboardError } from '../../src/errors.js';
import type { SecretStore } from '../../src/security/keychain.js';
import { ConfigStore } from '../../src/storage/config-store.js';

class MemorySecretStore implements SecretStore {
  public readonly values = new Map<string, string>();

  public async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  public async set(account: string, secret: string): Promise<void> {
    this.values.set(account, secret);
  }

  public async delete(account: string): Promise<boolean> {
    return this.values.delete(account);
  }
}

describe('OAuth identity verification', () => {
  it('normalizes and accepts the exact expected identity', () => {
    expect(assertExpectedIdentity('Jacob@Embrasure.ai', 'jacob@embrasure.ai'))
      .toBe('jacob@embrasure.ai');
  });

  it('rejects the wrong Google account before credentials are saved', () => {
    expect(() => assertExpectedIdentity('wrong@gmail.com', 'jacob@embrasure.ai'))
      .toThrow(expect.objectContaining<Partial<SwitchboardError>>({ code: 'WRONG_ACCOUNT' }));
  });

  it('deletes an imported OAuth JSON only after storing it in Keychain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gmail-switchboard-auth-'));
    const source = join(directory, 'oauth-client.json');
    const keychain = new MemorySecretStore();
    await writeFile(source, JSON.stringify({
      installed: {
        client_id: 'test-client-id',
        client_secret: 'test-secret-value',
      },
    }), { mode: 0o600 });

    try {
      const auth = new AuthManager(new ConfigStore(join(directory, 'accounts.json')), keychain);
      await auth.importClientFile(source, { deleteSource: true });

      expect(await keychain.get('oauth-client')).toBe(JSON.stringify({
        clientId: 'test-client-id',
        clientSecret: 'test-secret-value',
      }));
      await expect(readFile(source, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
