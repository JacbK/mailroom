import { gmail, type gmail_v1 } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { MailroomError } from '../errors.js';
import { KeychainStore, type SecretStore } from '../security/keychain.js';
import { ConfigStore } from '../storage/config-store.js';
import type { AccountConfig, AccountCredential, OAuthClientConfig } from '../types.js';
import { GMAIL_MODIFY_SCOPE } from '../auth/scopes.js';

const clientSchema = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) });
const credentialSchema = z.object({
  email: z.email(),
  refreshToken: z.string().min(1),
  scope: z.literal(GMAIL_MODIFY_SCOPE),
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
      throw new MailroomError(
        'AUTH_REQUIRED',
        'No Google OAuth client is configured.',
        'Run `./setup` and provide a Google Desktop OAuth client JSON file.',
      );
    }
    try {
      return clientSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new MailroomError(
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
      throw new MailroomError(
        'AUTH_REQUIRED',
        `The "${alias}" Gmail account is not authenticated.`,
        `Run \`./mailroom auth add ${alias}\` to authenticate it.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new MailroomError(
        'AUTH_REQUIRED',
        `The "${alias}" credential stored in Keychain is invalid.`,
        `Run \`./mailroom auth reauth ${alias}\`.`,
        { cause: error },
      );
    }
    const priorCredential = z.object({
      email: z.email(),
      refreshToken: z.string().min(1),
      scope: z.string().optional(),
    }).safeParse(parsed);
    if (priorCredential.success && priorCredential.data.scope !== GMAIL_MODIFY_SCOPE) {
      throw new MailroomError(
        'AUTH_REQUIRED',
        `The "${alias}" Gmail connection needs the new mail-management permission.`,
        `Run ./mailroom auth reauth ${alias} and approve access again.`,
      );
    }
    try {
      return credentialSchema.parse(parsed);
    } catch (error) {
      throw new MailroomError(
        'AUTH_REQUIRED',
        `The "${alias}" credential stored in Keychain is invalid.`,
        `Run ./mailroom auth reauth ${alias}.`,
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
      throw new MailroomError(
        'AUTH_REQUIRED',
        `Stored identity mismatch for "${alias}".`,
        `Run \`./mailroom auth reauth ${alias}\` and choose ${account.email}.`,
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
