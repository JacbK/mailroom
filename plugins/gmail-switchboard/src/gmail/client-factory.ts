import { gmail, type gmail_v1 } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { SwitchboardError } from '../errors.js';
import { KeychainStore, type SecretStore } from '../security/keychain.js';
import { ConfigStore } from '../storage/config-store.js';
import type { AccountConfig, AccountCredential, OAuthClientConfig } from '../types.js';

const clientSchema = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) });
const credentialSchema = z.object({
  email: z.email(),
  refreshToken: z.string().min(1),
});

export interface GmailConnection {
  account: AccountConfig;
  gmail: gmail_v1.Gmail;
}

export class GmailClientFactory {
  public constructor(
    private readonly config = new ConfigStore(),
    private readonly keychain: SecretStore = new KeychainStore(),
  ) {}

  public async getClientConfig(): Promise<OAuthClientConfig> {
    const raw = await this.keychain.get('oauth-client');
    if (!raw) {
      throw new SwitchboardError(
        'AUTH_REQUIRED',
        'No Google OAuth client is configured.',
        'Run `./setup` and provide a Google Desktop OAuth client JSON file.',
      );
    }
    try {
      return clientSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new SwitchboardError(
        'AUTH_REQUIRED',
        'The Google OAuth client stored in Keychain is invalid.',
        'Run `./setup --reauth` and replace the OAuth client configuration.',
        { cause: error },
      );
    }
  }

  public async getCredential(alias: string): Promise<AccountCredential> {
    const raw = await this.keychain.get(`account:${alias}`);
    if (!raw) {
      throw new SwitchboardError(
        'AUTH_REQUIRED',
        `The "${alias}" Gmail account is not authenticated.`,
        `Run \`./gmail-switchboard auth add ${alias}\` to authenticate it.`,
      );
    }
    try {
      return credentialSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new SwitchboardError(
        'AUTH_REQUIRED',
        `The "${alias}" credential stored in Keychain is invalid.`,
        `Run \`./gmail-switchboard auth reauth ${alias}\`.`,
        { cause: error },
      );
    }
  }

  public async connect(alias: string): Promise<GmailConnection> {
    const [account, client, credential] = await Promise.all([
      this.config.get(alias),
      this.getClientConfig(),
      this.getCredential(alias),
    ]);
    if (credential.email.toLowerCase() !== account.email.toLowerCase()) {
      throw new SwitchboardError(
        'AUTH_REQUIRED',
        `Stored identity mismatch for "${alias}".`,
        `Run \`./gmail-switchboard auth reauth ${alias}\` and choose ${account.email}.`,
      );
    }
    const auth = new OAuth2Client({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
    });
    auth.setCredentials({ refresh_token: credential.refreshToken });
    return { account, gmail: gmail({ version: 'v1', auth }) };
  }
}
