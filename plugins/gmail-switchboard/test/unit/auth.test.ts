import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertExpectedIdentity, AuthManager } from '../../src/auth/oauth.js';
import { GMAIL_MODIFY_SCOPE } from '../../src/auth/scopes.js';
import { SwitchboardError } from '../../src/errors.js';
import { GmailClientFactory } from '../../src/gmail/client-factory.js';
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
    expect(assertExpectedIdentity('Work@Example.com', 'work@example.com'))
      .toBe('work@example.com');
  });

  it('rejects the wrong Google account before credentials are saved', () => {
    expect(() => assertExpectedIdentity('wrong@gmail.com', 'work@example.com'))
      .toThrow(expect.objectContaining<Partial<SwitchboardError>>({ code: 'WRONG_ACCOUNT' }));
  });

  it('explains the one-time permission upgrade for old credentials', async () => {
    const keychain = new MemorySecretStore();
    await keychain.set('account:work', JSON.stringify({
      email: 'work@example.com',
      refreshToken: 'old-read-token',
    }));
    const factory = new GmailClientFactory(undefined, keychain);

    const error = await factory.getCredential('work').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SwitchboardError);
    if (!(error instanceof SwitchboardError)) throw new Error('Expected SwitchboardError.');
    expect(error.message).toContain('new mail-management permission');
    expect(error.recovery).toContain('auth reauth work');
  });

  it('accepts credentials with the Gmail modify scope', async () => {
    const keychain = new MemorySecretStore();
    await keychain.set('account:work', JSON.stringify({
      email: 'work@example.com',
      refreshToken: 'modify-token',
      scope: GMAIL_MODIFY_SCOPE,
    }));
    const factory = new GmailClientFactory(undefined, keychain);

    await expect(factory.getCredential('work')).resolves.toMatchObject({
      email: 'work@example.com',
      scope: GMAIL_MODIFY_SCOPE,
    });
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

  it('preserves the OAuth JSON when the Keychain write fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gmail-switchboard-auth-'));
    const source = join(directory, 'oauth-client.json');
    const contents = JSON.stringify({
      installed: {
        client_id: 'test-client-id',
        client_secret: 'test-secret-value',
      },
    });
    await writeFile(source, contents, { mode: 0o600 });
    const failingKeychain: SecretStore = {
      get: async () => null,
      set: async () => { throw new Error('simulated Keychain failure'); },
      delete: async () => false,
    };

    try {
      const auth = new AuthManager(new ConfigStore(join(directory, 'accounts.json')), failingKeychain);
      await expect(auth.importClientFile(source, { deleteSource: true }))
        .rejects.toThrow('simulated Keychain failure');
      await expect(readFile(source, 'utf8')).resolves.toBe(contents);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports the exact source path when cleanup fails after a Keychain write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gmail-switchboard-auth-'));
    const source = join(directory, 'oauth-client.json');
    const keychain = new MemorySecretStore();
    await writeFile(source, JSON.stringify({
      installed: {
        client_id: 'test-client-id',
        client_secret: 'test-secret-value',
      },
    }), { mode: 0o600 });
    const cleanupBlockingKeychain: SecretStore = {
      get: async (account) => await keychain.get(account),
      set: async (account, secret) => {
        await keychain.set(account, secret);
        await rm(source);
        await mkdir(source);
      },
      delete: async (account) => await keychain.delete(account),
    };

    try {
      const auth = new AuthManager(
        new ConfigStore(join(directory, 'accounts.json')),
        cleanupBlockingKeychain,
      );
      const failure = await auth.importClientFile(source, { deleteSource: true })
        .then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(SwitchboardError);
      if (!(failure instanceof SwitchboardError)) throw new Error('Expected SwitchboardError.');
      expect(failure.code).toBe('CREDENTIAL_FILE_CLEANUP_FAILED');
      expect(failure.recovery).toContain(source);
      expect(await keychain.get('oauth-client')).not.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
