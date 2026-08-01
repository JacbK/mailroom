import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MailroomError } from '../errors.js';

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runKeychainHelper(args: string[], input?: string): Promise<ProcessResult> {
  if (process.platform !== 'darwin') {
    throw new MailroomError(
      'UNSUPPORTED_PLATFORM',
      'Secure credential storage currently requires macOS Keychain.',
      'Run Mailroom on macOS. A future release can add another OS credential provider.',
    );
  }

  const helper = join(dirname(fileURLToPath(import.meta.url)), 'keychain-helper');
  if (!existsSync(helper)) {
    throw new Error('Keychain helper is missing. Run `./setup` to rebuild Mailroom.');
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(helper, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-1_000_000);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-20_000);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

export class KeychainStore {
  public constructor(
    private readonly service = 'mailroom',
    private readonly legacyService: string | null = service === 'mailroom'
      ? 'gmail-switchboard'
      : null,
  ) {}

  public async get(account: string): Promise<string | null> {
    const result = await runKeychainHelper(['get', this.service, account]);
    if (result.code === 44 && this.legacyService) {
      const legacy = await runKeychainHelper(['get', this.legacyService, account]);
      if (legacy.code === 44) return null;
      if (legacy.code !== 0) throw new Error(`Legacy Keychain lookup failed (${legacy.code}).`);
      const secret = legacy.stdout.replace(/\n$/, '');
      await this.set(account, secret);
      const cleanup = await runKeychainHelper(['delete', this.legacyService, account]);
      if (cleanup.code !== 0 && cleanup.code !== 44) {
        throw new Error(`Legacy Keychain cleanup failed (${cleanup.code}).`);
      }
      return secret;
    }
    if (result.code === 44) return null;
    if (result.code !== 0) {
      throw new Error(`Keychain lookup failed (${result.code}).`);
    }
    return result.stdout.replace(/\n$/, '');
  }

  public async set(account: string, secret: string): Promise<void> {
    if (!secret) throw new Error('Refusing to store an empty Keychain secret.');
    const result = await runKeychainHelper(['set', this.service, account], secret);
    if (result.code !== 0) {
      throw new Error(`Keychain write failed (${result.code}).`);
    }
  }

  public async delete(account: string): Promise<boolean> {
    const result = await runKeychainHelper(['delete', this.service, account]);
    if (result.code !== 0 && result.code !== 44) {
      throw new Error(`Keychain delete failed (${result.code}).`);
    }
    let legacyRemoved = false;
    if (this.legacyService) {
      const legacy = await runKeychainHelper(['delete', this.legacyService, account]);
      if (legacy.code !== 0 && legacy.code !== 44) {
        throw new Error(`Legacy Keychain delete failed (${legacy.code}).`);
      }
      legacyRemoved = legacy.code === 0;
    }
    return result.code === 0 || legacyRemoved;
  }
}

export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}
