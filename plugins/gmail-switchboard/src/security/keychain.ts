import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SwitchboardError } from '../errors.js';

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runKeychainHelper(args: string[], input?: string): Promise<ProcessResult> {
  if (process.platform !== 'darwin') {
    throw new SwitchboardError(
      'UNSUPPORTED_PLATFORM',
      'Secure credential storage currently requires macOS Keychain.',
      'Run Gmail Switchboard on macOS. A future release can add another OS credential provider.',
    );
  }

  const helper = join(dirname(fileURLToPath(import.meta.url)), 'keychain-helper');
  if (!existsSync(helper)) {
    throw new Error('Keychain helper is missing. Run `./setup` to rebuild Gmail Switchboard.');
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
  public constructor(private readonly service = 'gmail-switchboard') {}

  public async get(account: string): Promise<string | null> {
    const result = await runKeychainHelper(['get', this.service, account]);
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
    if (result.code === 44) return false;
    if (result.code !== 0) throw new Error(`Keychain delete failed (${result.code}).`);
    return true;
  }
}

export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}
