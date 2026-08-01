import { randomBytes } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { gmail } from '@googleapis/gmail';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { MailroomError } from '../errors.js';
import { KeychainStore, type SecretStore } from '../security/keychain.js';
import { ConfigStore } from '../storage/config-store.js';
import type {
  AccountCredential,
  OAuthClientConfig,
  OAuthClientSelection,
  OAuthMode,
} from '../types.js';
import { OAuthClientStore } from './client-store.js';
import { GMAIL_MODIFY_SCOPE } from './scopes.js';

export type OAuthGrant = (
  alias: string,
  expectedEmail: string,
  client: OAuthClientConfig,
  selection: OAuthClientSelection,
) => Promise<AccountCredential>;

const OAUTH_TIMEOUT_MS = 15 * 60 * 1_000;
const SHARED_OAUTH_DENIALS = [
  'access_denied',
  'admin_policy_enforced',
  'disallowed_useragent',
  'org_internal',
  'rate_limit_exceeded',
];

const clientFileSchema = z.object({
  installed: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
  }),
});

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
  const preferredBrowser = (
    process.env.MAILROOM_BROWSER ?? process.env.GMAIL_SWITCHBOARD_BROWSER
  )?.trim();
  const args = process.platform === 'darwin' && preferredBrowser
    ? ['-a', preferredBrowser, url]
    : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function createOAuthCallback(expectedState: string): Promise<{
  redirectUri: string;
  waitForCode: () => Promise<string>;
  close: () => Promise<void>;
}> {
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((error: Error) => void) | undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (requestUrl.pathname !== '/oauth/callback') {
      response.writeHead(404).end('Not found');
      return;
    }
    const state = requestUrl.searchParams.get('state');
    const error = requestUrl.searchParams.get('error');
    const code = requestUrl.searchParams.get('code');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Connection', 'close');
    if (state !== expectedState) {
      response.writeHead(400).end('Authentication failed: state mismatch. You can close this tab.');
      rejectCode?.(new Error('OAuth state mismatch.'));
      return;
    }
    if (error || !code) {
      response.writeHead(400).end('Authentication was not completed. You can close this tab.');
      rejectCode?.(new Error(`OAuth authorization failed: ${error ?? 'missing code'}.`));
      return;
    }
    response.writeHead(200).end('Mailroom is connected. You can close this tab.');
    resolveCode?.(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not create OAuth callback.');
  const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
  const timeout = setTimeout(
    () => rejectCode?.(new Error('OAuth flow timed out.')),
    OAUTH_TIMEOUT_MS,
  );
  const close = async (): Promise<void> => {
    clearTimeout(timeout);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };
  return { redirectUri, waitForCode: async () => await codePromise, close };
}

export class AuthManager {
  private readonly clients: OAuthClientStore;
  private readonly grant: OAuthGrant;

  public constructor(
    private readonly config = new ConfigStore(),
    private readonly keychain: SecretStore = new KeychainStore(),
    grant?: OAuthGrant,
  ) {
    this.clients = new OAuthClientStore(keychain);
    this.grant = grant ?? (async (alias, email, client, selection) => (
      await this.authorizeWithRetries(alias, email, client, selection)
    ));
  }

  public async clientStatus(): Promise<{
    configured: boolean;
    mode: OAuthMode | null;
    fingerprint: string | null;
    ok: boolean;
  }> {
    try {
      const selection = await this.clients.getSelection();
      await this.clients.getClient(selection);
      return {
        configured: true,
        mode: selection.mode,
        fingerprint: selection.fingerprint,
        ok: true,
      };
    } catch {
      return { configured: false, mode: null, fingerprint: null, ok: false };
    }
  }

  public async useSharedClient(): Promise<boolean> {
    return await this.switchClient('shared');
  }

  public async useSelfHostedClient(
    path: string,
    options: { deleteSource?: boolean } = {},
  ): Promise<boolean> {
    const client = await this.readClientFile(path);
    const changed = await this.switchClient('self-hosted', client);
    if (options.deleteSource) await this.deleteClientFile(path);
    return changed;
  }

  public async importClientFile(
    path: string,
    options: { deleteSource?: boolean } = {},
  ): Promise<void> {
    await this.useSelfHostedClient(path, options);
  }

  public async authorize(alias: string, expectedEmail: string): Promise<void> {
    const { client, selection } = await this.clients.getActiveClient();
    const credential = await this.grant(alias, expectedEmail, client, selection);
    await this.keychain.set(
      this.clients.credentialKey(selection, alias),
      JSON.stringify(credential),
    );
    await this.config.upsert({ alias, email: credential.email });
  }

  public async remove(alias: string, revoke = true): Promise<boolean> {
    const selection = await this.clients.getSelection().catch(() => null);
    const client = selection
      ? await this.clients.getClient(selection).catch(() => null)
      : null;
    const key = selection ? this.clients.credentialKey(selection, alias) : null;
    const rawCredential = (key ? await this.keychain.get(key) : null)
      ?? await this.keychain.get(`account:${alias}`);
    if (revoke && rawCredential) {
      try {
        const credential = z.object({ refreshToken: z.string() }).parse(JSON.parse(rawCredential));
        const oauth = new OAuth2Client(client ? {
          clientId: client.clientId,
          clientSecret: client.clientSecret,
        } : undefined);
        await oauth.revokeToken(credential.refreshToken);
      } catch {
        // Local removal still proceeds. Google Account settings can revoke access manually.
      }
    }
    const [currentRemoved, legacyRemoved, configRemoved] = await Promise.all([
      key ? this.keychain.delete(key) : false,
      this.keychain.delete(`account:${alias}`),
      this.config.remove(alias),
    ]);
    return currentRemoved || legacyRemoved || configRemoved;
  }

  public async purge(): Promise<void> {
    const accounts = await this.config.list();
    const selection = await this.clients.getSelection().catch(() => null);
    for (const account of accounts) await this.remove(account.alias, true);
    if (selection) {
      await this.clients.deleteSelection(selection, accounts.map((account) => account.alias));
    }
    await this.clients.clearSelection();
    await this.config.clear();
  }

  private async switchClient(
    mode: OAuthMode,
    customClient?: OAuthClientConfig,
  ): Promise<boolean> {
    const previous = await this.clients.getSelection();
    let target: OAuthClientSelection;
    if (mode === 'shared') {
      target = this.clients.sharedSelection();
    } else {
      if (!customClient) throw new Error('A self-hosted OAuth client is required.');
      target = await this.clients.prepareSelfHosted(customClient);
    }
    if (previous.mode === target.mode && previous.fingerprint === target.fingerprint) return false;
    if (previous.fingerprint === target.fingerprint) {
      await this.clients.activate(target);
      await this.clients.deleteClient(previous);
      return true;
    }

    const client = await this.clients.getClient(target);
    const accounts = await this.config.list();
    const credentials: Array<{ alias: string; credential: AccountCredential }> = [];
    try {
      for (const account of accounts) {
        const credential = await this.grant(
          account.alias,
          account.email,
          client,
          target,
        );
        credentials.push({ alias: account.alias, credential });
      }
    } catch (error) {
      if (target.mode === 'self-hosted') {
        await this.clients.deleteSelection(target, []);
      }
      throw error;
    }

    try {
      for (const item of credentials) {
        await this.keychain.set(
          this.clients.credentialKey(target, item.alias),
          JSON.stringify(item.credential),
        );
      }
      await this.clients.activate(target);
    } catch (error) {
      await this.clients.deleteSelection(target, credentials.map((item) => item.alias));
      throw error;
    }
    await this.clients.deleteSelection(previous, accounts.map((account) => account.alias));
    return true;
  }

  private async authorizeWithRetries(
    alias: string,
    expectedEmail: string,
    client: OAuthClientConfig,
    selection: OAuthClientSelection,
  ): Promise<AccountCredential> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.authorizeOnce(alias, expectedEmail, client, selection);
      } catch (error) {
        if (!(error instanceof MailroomError)
          || error.code !== 'WRONG_ACCOUNT'
          || attempt === 3) {
          throw error;
        }
        process.stderr.write(`${error.message} Reopening Google account selection…\n`);
      }
    }
    throw new Error('OAuth retry loop ended unexpectedly.');
  }

  private async authorizeOnce(
    alias: string,
    expectedEmail: string,
    client: OAuthClientConfig,
    selection: OAuthClientSelection,
  ): Promise<AccountCredential> {
    const state = randomBytes(32).toString('base64url');
    const callback = await createOAuthCallback(state);
    try {
      const oauth = new OAuth2Client({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUri: callback.redirectUri,
      });
      const verifier = await oauth.generateCodeVerifierAsync();
      if (!verifier.codeChallenge) throw new Error('Could not create an OAuth PKCE challenge.');
      const authUrl = oauth.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent select_account',
        scope: [GMAIL_MODIFY_SCOPE],
        login_hint: expectedEmail,
        state,
        code_challenge: verifier.codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
      });
      process.stderr.write([
        `Mailroom is requesting access to ${expectedEmail} to read, draft, send, forward, label, archive, and Trash email.`,
        'Mailroom runs locally. Requested email is returned to your active Codex or Claude task and may be processed by that provider. Tokens stay in macOS Keychain.',
        `Opening Google sign-in for ${alias} (${expectedEmail})…`,
        '',
      ].join('\n'));
      openBrowser(authUrl);
      const code = await callback.waitForCode();
      const { tokens } = await oauth.getToken({
        code,
        codeVerifier: verifier.codeVerifier,
        redirect_uri: callback.redirectUri,
      });
      oauth.setCredentials(tokens);
      const gmailClient = gmail({ version: 'v1', auth: oauth });
      const profile = await gmailClient.users.getProfile({ userId: 'me' });
      const authenticatedEmail = assertExpectedIdentity(profile.data.emailAddress, expectedEmail);
      if (!tokens.refresh_token) {
        throw new MailroomError(
          'AUTH_REQUIRED',
          'Google did not return an offline refresh token.',
          'Remove Mailroom from your Google Account connections, then retry authentication.',
        );
      }
      return {
        email: authenticatedEmail,
        refreshToken: tokens.refresh_token,
        scope: GMAIL_MODIFY_SCOPE,
        clientFingerprint: selection.fingerprint,
      };
    } catch (error) {
      throw normalizeOAuthFailure(error, selection.mode);
    } finally {
      await callback.close();
    }
  }

  private async readClientFile(path: string): Promise<OAuthClientConfig> {
    try {
      const parsed = clientFileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      return {
        clientId: parsed.installed.client_id,
        clientSecret: parsed.installed.client_secret,
      };
    } catch (error) {
      throw new MailroomError(
        'INVALID_INPUT',
        'That file is not a valid Google Desktop OAuth client JSON file.',
        'In Google Cloud Console, create an OAuth client with application type “Desktop app” and download its JSON.',
        { cause: error },
      );
    }
  }

  private async deleteClientFile(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      throw new MailroomError(
        'CREDENTIAL_FILE_CLEANUP_FAILED',
        'The OAuth client is in Keychain, but the downloaded JSON could not be deleted.',
        `Delete the downloaded OAuth JSON manually at ${path}. Rerunning setup will keep using the Keychain copy.`,
        { cause: error },
      );
    }
  }
}

export function normalizeOAuthFailure(error: unknown, mode: OAuthMode): unknown {
  if (error instanceof MailroomError || mode !== 'shared') return error;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (!SHARED_OAUTH_DENIALS.some((reason) => message.includes(reason))) return error;
  return new MailroomError(
    'AUTH_REQUIRED',
    'Google did not allow Mailroom to finish sign-in.',
    'If you cancelled, rerun setup. If Google says Mailroom is blocked or unverified, use `./setup --self-host <oauth-json>`.',
    { cause: error },
  );
}

export function assertExpectedIdentity(actual: string | null | undefined, expected: string): string {
  const authenticatedEmail = actual?.toLowerCase();
  if (authenticatedEmail !== expected.toLowerCase()) {
    throw new MailroomError(
      'WRONG_ACCOUNT',
      `Google authenticated ${authenticatedEmail ?? 'an unknown account'}, not ${expected}.`,
      `Retry and choose ${expected}. Nothing from the wrong account was saved.`,
    );
  }
  return authenticatedEmail;
}
