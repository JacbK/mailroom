import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { AuthManager } from './auth/oauth.js';
import { doctorJson, doctorText, type DoctorReport } from './diagnostics.js';
import { GmailService } from './gmail/service.js';
import { safeDiagnostic } from './security/redact.js';
import { ConfigStore } from './storage/config-store.js';

const program = new Command();
const auth = new Command('auth');
const client = new Command('client');

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
  .name('mailroom')
  .description('Mailroom setup and diagnostics.')
  .version(packageJson.version);

client
  .command('set')
  .argument('<path>', 'Google Desktop OAuth client JSON file')
  .option('--delete-source', 'Delete the JSON file after it is stored in Keychain.')
  .description('Store the OAuth client in Keychain.')
  .action(async (path: string, options: { deleteSource?: boolean }) => {
    const changed = await new AuthManager().useSelfHostedClient(path, options);
    process.stdout.write(options.deleteSource
      ? `Self-hosted Google app ${changed ? 'enabled' : 'already active'}; source JSON deleted.\n`
      : `Self-hosted Google app ${changed ? 'enabled' : 'already active'}.\n`);
  });

client
  .command('shared')
  .description('Use the legacy shared Mailroom Google app.')
  .action(async () => {
    process.stderr.write('Warning: shared OAuth is legacy. Use `./setup --personal` for reliable sign-in.\n');
    const changed = await new AuthManager().useSharedClient();
    process.stdout.write(`Legacy shared Google app ${changed ? 'enabled' : 'already active'}.\n`);
  });

client
  .command('status')
  .option('--json', 'Print machine-readable JSON')
  .description('Check OAuth client setup.')
  .action(async (options: { json?: boolean }) => {
    const status = await new AuthManager().clientStatus();
    process.stdout.write(options.json
      ? `${JSON.stringify(status)}\n`
      : `Google OAuth: ${status.ok
        ? status.mode === 'shared' ? 'legacy shared app' : 'personal app'
        : 'needs setup'}\n`);
    if (!status.ok) process.exitCode = 2;
  });

auth
  .command('add')
  .argument('<alias>', 'Short alias such as work or personal')
  .argument('<email>', 'Exact Google account email expected during OAuth')
  .description('Connect one Gmail account.')
  .action(async (alias: string, email: string) => {
    await new AuthManager().authorize(alias, email);
    process.stdout.write(`Connected ${alias} as ${email.toLowerCase()}.\n`);
  });

auth
  .command('reauth')
  .argument('<alias>', 'Configured account alias')
  .description('Reconnect one account.')
  .action(async (alias: string) => {
    const account = await new ConfigStore().get(alias);
    await new AuthManager().authorize(account.alias, account.email);
    process.stdout.write(`Reconnected ${account.alias} as ${account.email}.\n`);
  });

auth
  .command('list')
  .option('--json', 'Print machine-readable JSON')
  .description('List accounts and status.')
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
  .description('Revoke and remove one account.')
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
  .option('--redact', 'Hide account aliases, emails, and OAuth details in diagnostics')
  .description('Check setup and account health.')
  .action(async (options: { json?: boolean; redact?: boolean }) => {
    const major = Number(process.versions.node.split('.')[0]);
    const authManager = new AuthManager();
    const clientStatus = await authManager.clientStatus();
    const accounts = await new GmailService().accounts();
    const report: DoctorReport = {
      node: { version: process.versions.node, ok: major >= 22 },
      platform: { value: process.platform, ok: process.platform === 'darwin' },
      oauth_client: clientStatus,
      account_count: accounts.length,
      accounts,
      ok: major >= 22
        && process.platform === 'darwin'
        && clientStatus.ok
        && accounts.length > 0
        && accounts.every((account) => account.status === 'connected'),
    };
    process.stdout.write(options.json
      ? `${JSON.stringify(doctorJson(report, options.redact ?? false))}\n`
      : doctorText(report, options.redact ?? false));
    if (!report.ok) process.exitCode = 2;
  });

program
  .command('smoke')
  .option('--account <alias>', 'Check one account alias instead of all configured accounts')
  .option('--json', 'Print machine-readable JSON')
  .description('Test search and reads without printing email content.')
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
      partial: page.partial,
      partial_reason: page.partial_reason,
      qualified_ids: page.results.every((item) => (
        item.message_id.startsWith(`${item.account_alias}:`)
        && item.thread_id.startsWith(`${item.account_alias}:`)
      )),
      sample,
      ok: !page.partial && page.results.every((item) => (
        item.message_id.startsWith(`${item.account_alias}:`)
        && item.thread_id.startsWith(`${item.account_alias}:`)
      )) && (sample === null || (sample.message_read && sample.thread_read)),
    };
    if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else process.stdout.write([
      `Accounts checked: ${page.searched_accounts.map((account) => account.alias).join(', ')}`,
      `Search results checked: ${page.result_count}`,
      `Complete page: ${page.partial ? 'no' : 'ok'}`,
      `Namespaced IDs: ${report.qualified_ids ? 'ok' : 'failed'}`,
      `Message and thread read: ${sample === null ? 'no messages found' : report.ok ? 'ok' : 'failed'}`,
      '',
    ].join('\n'));
    if (!report.ok) process.exitCode = 2;
  });

program
  .command('purge')
  .option('-y, --yes', 'Skip confirmation')
  .description('Revoke all access and delete local credentials.')
  .action(async (options: { yes?: boolean }) => {
    const approved = options.yes || await confirm('Revoke all Gmail access and delete local credentials?');
    if (!approved) throw new Error('Cancelled without changing credentials.');
    await new AuthManager().purge();
    process.stdout.write('Removed Mailroom credentials and local account configuration.\n');
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${safeDiagnostic(error)}\n`);
  process.exitCode = 1;
});
