import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MailroomError } from '../errors.js';
import { KeychainStore, type SecretStore } from '../security/keychain.js';
import type {
  OAuthClientConfig,
  OAuthClientSelection,
  OAuthMode,
} from '../types.js';
import { SHARED_OAUTH_CLIENT } from './shared-client.js';

const clientSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});
export const OAUTH_CLIENT_FINGERPRINT_LENGTH = 16;
const selectionSchema = z.object({
  mode: z.enum(['shared', 'self-hosted']),
  fingerprint: z.string().length(OAUTH_CLIENT_FINGERPRINT_LENGTH),
});

export function fingerprintOAuthClient(client: OAuthClientConfig): string {
  return createHash('sha256')
    .update(client.clientId)
    .digest('hex')
    .slice(0, OAUTH_CLIENT_FINGERPRINT_LENGTH);
}

export class OAuthClientStore {
  public constructor(private readonly keychain: SecretStore = new KeychainStore()) {}

  public sharedSelection(): OAuthClientSelection {
    return {
      mode: 'shared',
      fingerprint: fingerprintOAuthClient(SHARED_OAUTH_CLIENT),
    };
  }

  public credentialKey(selection: OAuthClientSelection, alias: string): string {
    return `account:${selection.fingerprint}:${alias}`;
  }

  public async getSelection(): Promise<OAuthClientSelection> {
    const raw = await this.keychain.get('oauth-selection');
    if (raw) {
      try {
        return selectionSchema.parse(JSON.parse(raw));
      } catch (error) {
        throw new MailroomError(
          'AUTH_REQUIRED',
          'The active Google OAuth configuration is invalid.',
          'Run `./setup --personal` or `./setup --self-host <oauth-json>`.',
          { cause: error },
        );
      }
    }

    const legacy = await this.keychain.get('oauth-client');
    if (legacy) {
      const client = this.parseClient(legacy);
      const selection = await this.prepareSelfHosted(client);
      await this.activate(selection);
      await this.keychain.delete('oauth-client');
      return selection;
    }

    throw new MailroomError(
      'AUTH_REQUIRED',
      'A personal Google OAuth app is not configured.',
      'Run `./setup --personal`. Mailroom will open the setup guide and securely import the downloaded Desktop OAuth JSON.',
    );
  }

  public async getActiveClient(): Promise<{
    client: OAuthClientConfig;
    selection: OAuthClientSelection;
  }> {
    const selection = await this.getSelection();
    return { selection, client: await this.getClient(selection) };
  }

  public async getClient(selection: OAuthClientSelection): Promise<OAuthClientConfig> {
    if (selection.mode === 'shared') {
      const expected = this.sharedSelection();
      if (selection.fingerprint !== expected.fingerprint) {
        throw new MailroomError(
          'AUTH_REQUIRED',
          'The legacy shared Mailroom OAuth client changed.',
          'Run `./setup --personal` and reconnect your Gmail accounts.',
        );
      }
      return SHARED_OAUTH_CLIENT;
    }

    const raw = await this.keychain.get(`oauth-client:${selection.fingerprint}`);
    if (!raw) {
      throw new MailroomError(
        'AUTH_REQUIRED',
        'The personal Google OAuth client is missing.',
        'Run `./setup --self-host <oauth-json>`.',
      );
    }
    const client = this.parseClient(raw);
    if (fingerprintOAuthClient(client) !== selection.fingerprint) {
      throw new MailroomError(
        'AUTH_REQUIRED',
        'The personal Google OAuth client does not match the active configuration.',
        'Run `./setup --self-host <oauth-json>` again.',
      );
    }
    return client;
  }

  public async prepareSelfHosted(client: OAuthClientConfig): Promise<OAuthClientSelection> {
    const parsed = clientSchema.parse(client);
    const selection: OAuthClientSelection = {
      mode: 'self-hosted',
      fingerprint: fingerprintOAuthClient(parsed),
    };
    await this.keychain.set(`oauth-client:${selection.fingerprint}`, JSON.stringify(parsed));
    return selection;
  }

  public async activate(selection: OAuthClientSelection): Promise<void> {
    await this.keychain.set('oauth-selection', JSON.stringify(selection));
  }

  public async deleteSelection(
    selection: OAuthClientSelection,
    aliases: string[],
  ): Promise<void> {
    for (const alias of aliases) {
      await this.keychain.delete(this.credentialKey(selection, alias));
    }
    await this.deleteClient(selection);
  }

  public async deleteClient(selection: OAuthClientSelection): Promise<void> {
    if (selection.mode === 'self-hosted') {
      await this.keychain.delete(`oauth-client:${selection.fingerprint}`);
    }
  }

  public async clearSelection(): Promise<void> {
    await this.keychain.delete('oauth-selection');
    await this.keychain.delete('oauth-client');
  }

  public modeLabel(mode: OAuthMode): string {
    return mode === 'shared' ? 'legacy shared app' : 'personal app';
  }

  private parseClient(raw: string): OAuthClientConfig {
    try {
      return clientSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new MailroomError(
        'AUTH_REQUIRED',
        'The Google OAuth client stored in Keychain is invalid.',
        'Run `./setup --personal` or `./setup --self-host <oauth-json>`.',
        { cause: error },
      );
    }
  }
}
