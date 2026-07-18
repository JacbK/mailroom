import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprintOAuthClient, OAuthClientStore } from '../../src/auth/client-store.js';
import { assertExpectedIdentity, AuthManager } from '../../src/auth/oauth.js';
import { GMAIL_MODIFY_SCOPE } from '../../src/auth/scopes.js';
import { MailroomError } from '../../src/errors.js';
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
      .toThrow(expect.objectContaining<Partial<MailroomError>>({ code: 'WRONG_ACCOUNT' }));
  });

  it('explains the one-time permission upgrade for old credentials', async () => {
    const keychain = new MemorySecretStore();
    await keychain.set('account:work', JSON.stringify({
      email: 'work@example.com',
      refreshToken: 'old-read-token',
    }));
    const factory = new GmailClientFactory(undefined, keychain);

    const error = await factory.getCredential('work').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailroomError);
    if (!(error instanceof MailroomError)) throw new Error('Expected MailroomError.');
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

  it('rejects a credential stamped for a different OAuth client', async () => {
    const keychain = new MemorySecretStore();
    const clients = new OAuthClientStore(keychain);
    const selection = clients.sharedSelection();
    await keychain.set(clients.credentialKey(selection, 'work'), JSON.stringify({
      email: 'work@example.com',
      refreshToken: 'modify-token',
      scope: GMAIL_MODIFY_SCOPE,
      clientFingerprint: 'ffffffffffffffff',
    }));

    await expect(new GmailClientFactory(undefined, keychain).getCredential('work'))
      .rejects.toThrow('belongs to a different OAuth app');
  });

  it('deletes local account data when the OAuth client is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mailroom-auth-'));
    const config = new ConfigStore(join(directory, 'accounts.json'));
    const keychain = new MemorySecretStore();
    const clients = new OAuthClientStore(keychain);
    const selection = await clients.prepareSelfHosted({
      clientId: 'missing-client',
      clientSecret: 'missing-secret',
    });
    await clients.activate(selection);
    await config.upsert({ alias: 'work', email: 'work@example.com' });
    const credentialKey = clients.credentialKey(selection, 'work');
    await keychain.set(credentialKey, JSON.stringify({
      email: 'work@example.com',
      refreshToken: 'refresh-token',
      scope: GMAIL_MODIFY_SCOPE,
      clientFingerprint: selection.fingerprint,
    }));
    await keychain.delete(`oauth-client:${selection.fingerprint}`);

    try {
      await expect(new AuthManager(config, keychain).remove('work', false)).resolves.toBe(true);
      await expect(keychain.get(credentialKey)).resolves.toBeNull();
      await expect(config.list()).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('deletes an imported OAuth JSON only after storing it in Keychain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mailroom-auth-'));
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

      const client = {
        clientId: 'test-client-id',
        clientSecret: 'test-secret-value',
      };
      expect((await auth.clientStatus()).mode).toBe('self-hosted');
      expect(await keychain.get(`oauth-client:${fingerprintOAuthClient(client)}`))
        .toBe(JSON.stringify(client));
      await expect(readFile(source, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves the OAuth JSON when the Keychain write fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mailroom-auth-'));
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
    const directory = await mkdtemp(join(tmpdir(), 'mailroom-auth-'));
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
        if (account.startsWith('oauth-client:')) {
          await rm(source);
          await mkdir(source);
        }
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
      expect(failure).toBeInstanceOf(MailroomError);
      if (!(failure instanceof MailroomError)) throw new Error('Expected MailroomError.');
      expect(failure.code).toBe('CREDENTIAL_FILE_CLEANUP_FAILED');
      expect(failure.recovery).toContain(source);
      expect([...keychain.values.keys()].some((key) => key.startsWith('oauth-client:')))
        .toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
