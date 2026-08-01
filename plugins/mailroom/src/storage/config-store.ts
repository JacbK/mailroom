import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { MailroomError } from '../errors.js';
import type { AccountConfig } from '../types.js';

const aliasSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const emailSchema = z.email().transform((value) => value.toLowerCase());
const accountsSchema = z.object({
  version: z.literal(1),
  accounts: z.array(z.object({ alias: aliasSchema, email: emailSchema })),
});

function defaultConfigPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'mailroom', 'accounts.json');
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'mailroom', 'accounts.json');
}

function legacyConfigPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'gmail-switchboard', 'accounts.json');
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'gmail-switchboard', 'accounts.json');
}

async function readAccounts(path: string): Promise<AccountConfig[]> {
  return accountsSchema.parse(JSON.parse(await readFile(path, 'utf8'))).accounts;
}

function invalidConfig(path: string, cause: unknown): MailroomError {
  return new MailroomError(
    'INVALID_INPUT',
    `Account configuration is invalid at ${path}.`,
    'Run `./setup --doctor` to inspect it, or move the file aside and rerun `./setup`.',
    { cause },
  );
}

export class ConfigStore {
  public constructor(
    public readonly path = defaultConfigPath(),
    private readonly legacyPath: string | null = path === defaultConfigPath()
      ? legacyConfigPath()
      : null,
  ) {}

  public async list(): Promise<AccountConfig[]> {
    try {
      return await readAccounts(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw invalidConfig(this.path, error);
      }
    }
    if (!this.legacyPath) return [];
    try {
      const accounts = await readAccounts(this.legacyPath);
      await this.write(accounts);
      await rm(this.legacyPath, { force: true });
      return accounts;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw invalidConfig(this.legacyPath, error);
    }
  }

  public async get(alias: string): Promise<AccountConfig> {
    const account = (await this.list()).find((item) => item.alias === alias);
    if (!account) {
      throw new MailroomError(
        'ACCOUNT_NOT_FOUND',
        `No Gmail account is configured with alias "${alias}".`,
        'Run `./mailroom auth list` or add the account with `./mailroom auth add`.',
      );
    }
    return account;
  }

  public async upsert(input: AccountConfig): Promise<AccountConfig> {
    const account = z.object({ alias: aliasSchema, email: emailSchema }).parse(input);
    const accounts = await this.list();
    const conflictingEmail = accounts.find(
      (item) => item.email === account.email && item.alias !== account.alias,
    );
    if (conflictingEmail) {
      throw new MailroomError(
        'INVALID_INPUT',
        `${account.email} is already configured as "${conflictingEmail.alias}".`,
        'Remove the old alias first or reuse it.',
      );
    }
    const next = accounts.filter((item) => item.alias !== account.alias);
    next.push(account);
    next.sort((a, b) => a.alias.localeCompare(b.alias));
    await this.write(next);
    return account;
  }

  public async remove(alias: string): Promise<boolean> {
    const accounts = await this.list();
    const next = accounts.filter((item) => item.alias !== alias);
    if (next.length === accounts.length) return false;
    await this.write(next);
    return true;
  }

  public async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }

  private async write(accounts: AccountConfig[]): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, this.path);
  }
}
