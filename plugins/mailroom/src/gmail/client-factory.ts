import { gmail, type gmail_v1 } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import {
  OAUTH_CLIENT_FINGERPRINT_LENGTH,
  OAuthClientStore,
} from '../auth/client-store.js';
import { MailroomError } from '../errors.js';
import { KeychainStore, type SecretStore } from '../security/keychain.js';
import { ConfigStore } from '../storage/config-store.js';
import type { AccountConfig, AccountCredential, OAuthClientConfig } from '../types.js';
import { GMAIL_MODIFY_SCOPE } from '../auth/scopes.js';

const credentialSchema = z.object({
  email: z.email(),
  refreshToken: z.string().min(1),
  scope: z.literal(GMAIL_MODIFY_SCOPE),
  clientFingerprint: z.string().length(OAUTH_CLIENT_FINGERPRINT_LENGTH),
});

export interface GmailConnection {
  account: AccountConfig;
  gmail: gmail_v1.Gmail;
}

export class GmailClientFactory {
  private readonly clients: OAuthClientStore;

  public constructor(
    private readonly config = new ConfigStore(),
    private readonly keychain: SecretStore = new KeychainStore(),
  ) {
    this.clients = new OAuthClientStore(keychain);
  }

  public async getClientConfig(): Promise<OAuthClientConfig> {
    return (await this.clients.getActiveClient()).client;
  }

  public async getCredential(alias: string): Promise<AccountCredential> {
    const selection = await this.clients.getSelection();
    const key = this.clients.credentialKey(selection, alias);
    const current = await this.keychain.get(key);
    const legacy = current ? null : await this.keychain.get(`account:${alias}`);
    const raw = current ?? legacy;
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
      clientFingerprint: z.string().optional(),
    }).safeParse(parsed);
    if (priorCredential.success && priorCredential.data.scope !== GMAIL_MODIFY_SCOPE) {
      throw new MailroomError(
        'AUTH_REQUIRED',
        `The "${alias}" Gmail connection needs the new mail-management permission.`,
        `Run ./mailroom auth reauth ${alias} and approve access again.`,
      );
    }
    try {
      const credential = credentialSchema.parse({
        ...(priorCredential.success ? priorCredential.data : {}),
        clientFingerprint: priorCredential.success
          ? priorCredential.data.clientFingerprint ?? selection.fingerprint
          : undefined,
      });
      if (credential.clientFingerprint !== selection.fingerprint) {
        throw new MailroomError(
          'AUTH_REQUIRED',
          `The "${alias}" Gmail account belongs to a different OAuth app.`,
          `Run \`./mailroom auth reauth ${alias}\`.`,
        );
      }
      if (legacy) {
        await this.keychain.set(key, JSON.stringify(credential));
        await this.keychain.delete(`account:${alias}`);
      }
      return credential;
    } catch (error) {
      if (error instanceof MailroomError) throw error;
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
