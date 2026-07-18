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
import type { OAuthClientConfig } from '../types.js';
import { GMAIL_MODIFY_SCOPE } from './scopes.js';

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
  const timeout = setTimeout(() => rejectCode?.(new Error('OAuth flow timed out.')), 5 * 60 * 1_000);
  const close = async (): Promise<void> => {
    clearTimeout(timeout);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { redirectUri, waitForCode: async () => await codePromise, close };
}

export class AuthManager {
  public constructor(
    private readonly config = new ConfigStore(),
    private readonly keychain: SecretStore = new KeychainStore(),
  ) {}

  public async importClientFile(
    path: string,
    options: { deleteSource?: boolean } = {},
  ): Promise<void> {
    let parsed: z.infer<typeof clientFileSchema>;
    try {
      parsed = clientFileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      throw new MailroomError(
        'INVALID_INPUT',
        'That file is not a valid Google Desktop OAuth client JSON file.',
        'In Google Cloud Console, create an OAuth client with application type “Desktop app” and download its JSON.',
        { cause: error },
      );
    }
    await this.keychain.set('oauth-client', JSON.stringify({
      clientId: parsed.installed.client_id,
      clientSecret: parsed.installed.client_secret,
    } satisfies OAuthClientConfig));
    if (options.deleteSource) {
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

  public async hasClient(): Promise<boolean> {
    return (await this.keychain.get('oauth-client')) !== null;
  }

  public async authorize(alias: string, expectedEmail: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.authorizeOnce(alias, expectedEmail);
        return;
      } catch (error) {
        if (!(error instanceof MailroomError)
          || error.code !== 'WRONG_ACCOUNT'
          || attempt === 3) {
          throw error;
        }
        process.stderr.write(`${error.message} Reopening Google account selection…\n`);
      }
    }
  }

  private async authorizeOnce(alias: string, expectedEmail: string): Promise<void> {
    const rawClient = await this.keychain.get('oauth-client');
    if (!rawClient) {
      throw new MailroomError(
        'AUTH_REQUIRED',
        'No Google OAuth client is configured.',
        'Run `./setup` and provide a Google Desktop OAuth client JSON file.',
      );
    }
    const client = z.object({ clientId: z.string(), clientSecret: z.string() })
      .parse(JSON.parse(rawClient));
    const state = randomBytes(32).toString('base64url');
    const callback = await createOAuthCallback(state);
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
    process.stderr.write(`Opening Google sign-in for ${alias} (${expectedEmail})…\n`);
    openBrowser(authUrl);
    try {
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
      await this.keychain.set(`account:${alias}`, JSON.stringify({
        email: authenticatedEmail,
        refreshToken: tokens.refresh_token,
        scope: GMAIL_MODIFY_SCOPE,
      }));
      await this.config.upsert({ alias, email: authenticatedEmail });
    } finally {
      await callback.close();
    }
  }

  public async remove(alias: string, revoke = true): Promise<boolean> {
    const rawClient = await this.keychain.get('oauth-client');
    const rawCredential = await this.keychain.get(`account:${alias}`);
    if (revoke && rawClient && rawCredential) {
      try {
        const client = z.object({ clientId: z.string(), clientSecret: z.string() })
          .parse(JSON.parse(rawClient));
        const credential = z.object({ refreshToken: z.string() })
          .parse(JSON.parse(rawCredential));
        const oauth = new OAuth2Client({ clientId: client.clientId, clientSecret: client.clientSecret });
        await oauth.revokeToken(credential.refreshToken);
      } catch {
        // Local removal still proceeds. Google Account settings can revoke access manually.
      }
    }
    const [keychainRemoved, configRemoved] = await Promise.all([
      this.keychain.delete(`account:${alias}`),
      this.config.remove(alias),
    ]);
    return keychainRemoved || configRemoved;
  }

  public async purge(): Promise<void> {
    const accounts = await this.config.list();
    for (const account of accounts) await this.remove(account.alias, true);
    await this.keychain.delete('oauth-client');
    await this.config.clear();
  }
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
