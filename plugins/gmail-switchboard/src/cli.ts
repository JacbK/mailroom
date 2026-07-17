import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Command } from 'commander';
import { AuthManager } from './auth/oauth.js';
import { GmailService } from './gmail/service.js';
import { safeDiagnostic } from './security/redact.js';
import { ConfigStore } from './storage/config-store.js';

const program = new Command();
const auth = new Command('auth');
const client = new Command('client');
const requiredAccounts = [
  { alias: 'work', email: 'jacob@embrasure.ai' },
  { alias: 'personal', email: 'jacobk2112@gmail.com' },
] as const;

async function confirm(question: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await reader.question(`${question} [y/N] `);
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    reader.close();
  }
}

program
  .name('gmail-switchboard')
  .description('Secure local setup and diagnostics for Gmail Switchboard.')
  .version('0.1.0');

client
  .command('set')
  .argument('<path>', 'Google Desktop OAuth client JSON file')
  .description('Validate and store the OAuth client in macOS Keychain.')
  .action(async (path: string) => {
    await new AuthManager().importClientFile(path);
    process.stdout.write('Google OAuth client stored in macOS Keychain.\n');
  });

client
  .command('status')
  .option('--json', 'Print machine-readable JSON')
  .description('Report whether an OAuth client is stored.')
  .action(async (options: { json?: boolean }) => {
    const configured = await new AuthManager().hasClient();
    process.stdout.write(options.json
      ? `${JSON.stringify({ configured })}\n`
      : `Google OAuth client: ${configured ? 'configured' : 'missing'}\n`);
    if (!configured) process.exitCode = 2;
  });

auth
  .command('add')
  .argument('<alias>', 'Short alias such as work or personal')
  .argument('<email>', 'Exact Google account email expected during OAuth')
  .description('Authenticate and identity-check one Gmail account.')
  .action(async (alias: string, email: string) => {
    await new AuthManager().authorize(alias, email);
    process.stdout.write(`Connected ${alias} as ${email.toLowerCase()}.\n`);
  });

auth
  .command('reauth')
  .argument('<alias>', 'Configured account alias')
  .description('Repeat OAuth for one account and verify the same identity.')
  .action(async (alias: string) => {
    const account = await new ConfigStore().get(alias);
    await new AuthManager().authorize(account.alias, account.email);
    process.stdout.write(`Reconnected ${account.alias} as ${account.email}.\n`);
  });

auth
  .command('list')
  .option('--json', 'Print machine-readable JSON')
  .description('List aliases, verified addresses, and connection health. Never prints credentials.')
  .action(async (options: { json?: boolean }) => {
    const accounts = await new GmailService().accounts();
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ accounts })}\n`);
      return;
    }
    if (accounts.length === 0) {
      process.stdout.write('No Gmail accounts configured.\n');
      return;
    }
    for (const account of accounts) {
      process.stdout.write(`${account.alias}\t${account.email}\t${account.status}\n`);
    }
  });

auth
  .command('remove')
  .argument('<alias>', 'Configured account alias')
  .option('-y, --yes', 'Skip confirmation')
  .description('Revoke and remove one locally stored Gmail credential.')
  .action(async (alias: string, options: { yes?: boolean }) => {
    const approved = options.yes || await confirm(`Revoke and remove the "${alias}" Gmail connection?`);
    if (!approved) throw new Error('Cancelled without changing credentials.');
    const removed = await new AuthManager().remove(alias, true);
    process.stdout.write(removed ? `Removed ${alias}.\n` : `No account named ${alias} was configured.\n`);
  });

program.addCommand(client);
program.addCommand(auth);

program
  .command('doctor')
  .option('--json', 'Print machine-readable JSON')
  .description('Check Node, Keychain, OAuth, both clients, and Gmail account health.')
  .action(async (options: { json?: boolean }) => {
    const major = Number(process.versions.node.split('.')[0]);
    const authManager = new AuthManager();
    const clientConfigured = await authManager.hasClient();
    const accounts = await new GmailService().accounts();
    const required = requiredAccounts.map((expected) => {
      const actual = accounts.find((account) => account.alias === expected.alias);
      return {
        ...expected,
        status: actual?.email.toLowerCase() === expected.email
          ? actual.status
          : 'missing' as const,
      };
    });
    const report = {
      node: { version: process.versions.node, ok: major >= 22 },
      platform: { value: process.platform, ok: process.platform === 'darwin' },
      oauth_client: { configured: clientConfigured, ok: clientConfigured },
      accounts,
      required_accounts: required,
      ok: major >= 22
        && process.platform === 'darwin'
        && clientConfigured
        && required.every((account) => account.status === 'connected'),
    };
    process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : [
      `Node ${report.node.version}: ${report.node.ok ? 'ok' : 'needs Node 22+'}`,
      `macOS Keychain: ${report.platform.ok ? 'ok' : 'unsupported platform'}`,
      `Google OAuth client: ${clientConfigured ? 'configured' : 'missing'}`,
      ...required.map((account) => `${account.alias} (${account.email}): ${account.status}`),
      `Overall: ${report.ok ? 'healthy' : 'needs attention'}`,
      '',
    ].join('\n'));
    if (!report.ok) process.exitCode = 2;
  });

program
  .command('smoke')
  .option('--account <alias>', 'Check one account alias instead of all configured accounts')
  .option('--json', 'Print machine-readable JSON')
  .description('Run a privacy-safe real Gmail search, message read, and thread read without printing email content.')
  .action(async (options: { account?: string; json?: boolean }) => {
    const service = new GmailService();
    const page = await service.search({
      query: 'in:anywhere',
      ...(options.account ? { accounts: [options.account] } : {}),
      limit: 2,
    });
    const first = page.results[0];
    let sample: null | {
      account_alias: string;
      account_email: string;
      message_id: string;
      thread_id: string;
      message_read: boolean;
      thread_read: boolean;
      thread_message_count: number;
    } = null;
    if (first) {
      const message = await service.getMessage(first.message_id);
      const thread = await service.getThread(first.thread_id);
      sample = {
        account_alias: first.account_alias,
        account_email: first.account_email,
        message_id: first.message_id,
        thread_id: first.thread_id,
        message_read: message.message_id === first.message_id,
        thread_read: thread.thread_id === first.thread_id,
        thread_message_count: thread.messages.length,
      };
    }
    const report = {
      searched_accounts: page.searched_accounts,
      result_count: page.result_count,
      qualified_ids: page.results.every((item) => (
        item.message_id.startsWith(`${item.account_alias}:`)
        && item.thread_id.startsWith(`${item.account_alias}:`)
      )),
      sample,
      ok: page.results.every((item) => (
        item.message_id.startsWith(`${item.account_alias}:`)
        && item.thread_id.startsWith(`${item.account_alias}:`)
      )) && (sample === null || (sample.message_read && sample.thread_read)),
    };
    if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else process.stdout.write([
      `Accounts checked: ${page.searched_accounts.map((account) => account.alias).join(', ')}`,
      `Search results checked: ${page.result_count}`,
      `Namespaced IDs: ${report.qualified_ids ? 'ok' : 'failed'}`,
      `Message and thread read: ${sample === null ? 'no messages found' : report.ok ? 'ok' : 'failed'}`,
      '',
    ].join('\n'));
    if (!report.ok) process.exitCode = 2;
  });

program
  .command('purge')
  .option('-y, --yes', 'Skip confirmation')
  .description('Revoke all Gmail access and delete all Gmail Switchboard credentials and local account config.')
  .action(async (options: { yes?: boolean }) => {
    const approved = options.yes || await confirm('Revoke all Gmail access and delete local credentials?');
    if (!approved) throw new Error('Cancelled without changing credentials.');
    await new AuthManager().purge();
    process.stdout.write('Removed Gmail Switchboard credentials and local account configuration.\n');
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${safeDiagnostic(error)}\n`);
  process.exitCode = 1;
});
