import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OAuthClientStore } from '../../src/auth/client-store.js';
import { AuthManager, type OAuthGrant } from '../../src/auth/oauth.js';
import { GMAIL_MODIFY_SCOPE } from '../../src/auth/scopes.js';
import { GmailClientFactory } from '../../src/gmail/client-factory.js';
import type { SecretStore } from '../../src/security/keychain.js';
import { ConfigStore } from '../../src/storage/config-store.js';
import type { OAuthClientConfig } from '../../src/types.js';

class MemorySecretStore implements SecretStore {
  public readonly values = new Map<string, string>();
  public failOnSet: string | null = null;

  public async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  public async set(account: string, secret: string): Promise<void> {
    if (account === this.failOnSet) throw new Error('simulated Keychain write failure');
    this.values.set(account, secret);
  }

  public async delete(account: string): Promise<boolean> {
    return this.values.delete(account);
  }
}

const directories: string[] = [];

async function setup(): Promise<{
  clients: OAuthClientStore;
  config: ConfigStore;
  keychain: MemorySecretStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'mailroom-client-switch-'));
  directories.push(directory);
  const keychain = new MemorySecretStore();
  return {
    clients: new OAuthClientStore(keychain),
    config: new ConfigStore(join(directory, 'accounts.json')),
    keychain,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => (
    await rm(directory, { recursive: true, force: true })
  )));
});

describe('OAuth client selection', () => {
  it('requires a personal Google app for a fresh install', async () => {
    const { clients, config, keychain } = await setup();

    await expect(clients.getSelection()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    await expect(new AuthManager(config, keychain).clientStatus()).resolves.toEqual({
      configured: false,
      mode: null,
      fingerprint: null,
      ok: false,
    });
  });

  it('reports a broken self-hosted selection without crashing doctor callers', async () => {
    const { config, keychain } = await setup();
    await keychain.set('oauth-selection', JSON.stringify({
      mode: 'self-hosted',
      fingerprint: '1234567890abcdef',
    }));

    await expect(new AuthManager(config, keychain).clientStatus()).resolves.toEqual({
      configured: false,
      mode: null,
      fingerprint: null,
      ok: false,
    });
  });

  it('migrates existing client and account credentials as self-hosted', async () => {
    const { clients, config, keychain } = await setup();
    const legacyClient = { clientId: 'legacy-client', clientSecret: 'legacy-secret' };
    await keychain.set('oauth-client', JSON.stringify(legacyClient));
    await keychain.set('account:work', JSON.stringify({
      email: 'work@example.com',
      refreshToken: 'legacy-refresh',
      scope: GMAIL_MODIFY_SCOPE,
    }));

    const selection = await clients.getSelection();
    expect(selection.mode).toBe('self-hosted');
    await expect(keychain.get('oauth-client')).resolves.toBeNull();

    const credential = await new GmailClientFactory(config, keychain).getCredential('work');
    expect(credential.clientFingerprint).toBe(selection.fingerprint);
    await expect(keychain.get('account:work')).resolves.toBeNull();
    await expect(keychain.get(clients.credentialKey(selection, 'work'))).resolves.not.toBeNull();
  });

  it('keeps the old app active when any account fails during a switch', async () => {
    const { clients, config, keychain } = await setup();
    const custom: OAuthClientConfig = { clientId: 'custom-client', clientSecret: 'custom-secret' };
    const previous = await clients.prepareSelfHosted(custom);
    await clients.activate(previous);
    await config.upsert({ alias: 'personal', email: 'personal@example.com' });
    await config.upsert({ alias: 'work', email: 'work@example.com' });
    for (const alias of ['personal', 'work']) {
      await keychain.set(clients.credentialKey(previous, alias), JSON.stringify({
        email: `${alias}@example.com`,
        refreshToken: `${alias}-old`,
        scope: GMAIL_MODIFY_SCOPE,
        clientFingerprint: previous.fingerprint,
      }));
    }
    const grant: OAuthGrant = async (alias, email, _client, selection) => {
      if (alias === 'work') throw new Error('simulated second-account failure');
      return {
        email,
        refreshToken: `${alias}-new`,
        scope: GMAIL_MODIFY_SCOPE,
        clientFingerprint: selection.fingerprint,
      };
    };

    const auth = new AuthManager(config, keychain, grant);
    await expect(auth.useSharedClient()).rejects.toThrow('simulated second-account failure');
    await expect(clients.getSelection()).resolves.toEqual(previous);
    await expect(keychain.get(clients.credentialKey(previous, 'personal'))).resolves.not.toBeNull();
    await expect(keychain.get(clients.credentialKey(clients.sharedSelection(), 'personal')))
      .resolves.toBeNull();
  });

  it('keeps tokens when only the storage mode changes for the same OAuth client', async () => {
    const { clients, config, keychain } = await setup();
    const shared = clients.sharedSelection();
    const client = await clients.getClient(shared);
    const previous = await clients.prepareSelfHosted(client);
    await clients.activate(previous);
    await config.upsert({ alias: 'personal', email: 'personal@example.com' });
    const key = clients.credentialKey(previous, 'personal');
    await keychain.set(key, JSON.stringify({
      email: 'personal@example.com',
      refreshToken: 'still-valid',
      scope: GMAIL_MODIFY_SCOPE,
      clientFingerprint: previous.fingerprint,
    }));
    const unexpectedGrant: OAuthGrant = async () => {
      throw new Error('OAuth should not reopen for the same client ID.');
    };

    await expect(new AuthManager(config, keychain, unexpectedGrant).useSharedClient())
      .resolves.toBe(true);
    await expect(clients.getSelection()).resolves.toEqual(shared);
    await expect(keychain.get(key)).resolves.not.toBeNull();
    await expect(keychain.get(`oauth-client:${previous.fingerprint}`)).resolves.toBeNull();
  });

  it('activates the new app only after every account has authorized', async () => {
    const { clients, config, keychain } = await setup();
    const previous = await clients.prepareSelfHosted({
      clientId: 'custom-client',
      clientSecret: 'custom-secret',
    });
    await clients.activate(previous);
    await config.upsert({ alias: 'personal', email: 'personal@example.com' });
    await config.upsert({ alias: 'work', email: 'work@example.com' });
    const grant: OAuthGrant = async (alias, email, _client, selection) => ({
      email,
      refreshToken: `${alias}-new`,
      scope: GMAIL_MODIFY_SCOPE,
      clientFingerprint: selection.fingerprint,
    });

    const auth = new AuthManager(config, keychain, grant);
    await expect(auth.useSharedClient()).resolves.toBe(true);
    const current = clients.sharedSelection();
    await expect(clients.getSelection()).resolves.toEqual(current);
    await expect(keychain.get(clients.credentialKey(current, 'personal'))).resolves.not.toBeNull();
    await expect(keychain.get(clients.credentialKey(current, 'work'))).resolves.not.toBeNull();
    await expect(keychain.get(clients.credentialKey(previous, 'personal'))).resolves.toBeNull();
    await expect(keychain.get(`oauth-client:${previous.fingerprint}`)).resolves.toBeNull();
  });

  it('removes inactive credentials when a Keychain write interrupts a switch', async () => {
    const { clients, config, keychain } = await setup();
    const previous = await clients.prepareSelfHosted({
      clientId: 'custom-client',
      clientSecret: 'custom-secret',
    });
    await clients.activate(previous);
    await config.upsert({ alias: 'personal', email: 'personal@example.com' });
    await config.upsert({ alias: 'work', email: 'work@example.com' });
    for (const alias of ['personal', 'work']) {
      await keychain.set(clients.credentialKey(previous, alias), JSON.stringify({
        email: `${alias}@example.com`,
        refreshToken: `${alias}-old`,
        scope: GMAIL_MODIFY_SCOPE,
        clientFingerprint: previous.fingerprint,
      }));
    }
    const target = clients.sharedSelection();
    keychain.failOnSet = clients.credentialKey(target, 'work');
    const grant: OAuthGrant = async (alias, email, _client, selection) => ({
      email,
      refreshToken: `${alias}-new`,
      scope: GMAIL_MODIFY_SCOPE,
      clientFingerprint: selection.fingerprint,
    });

    const auth = new AuthManager(config, keychain, grant);
    await expect(auth.useSharedClient()).rejects.toThrow('simulated Keychain write failure');
    await expect(clients.getSelection()).resolves.toEqual(previous);
    await expect(keychain.get(clients.credentialKey(target, 'personal'))).resolves.toBeNull();
    await expect(keychain.get(clients.credentialKey(target, 'work'))).resolves.toBeNull();
    await expect(keychain.get(clients.credentialKey(previous, 'personal'))).resolves.not.toBeNull();
  });
});
