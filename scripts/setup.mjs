import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertAccountRequestAvailable,
  parseAccountSpec,
  requestedAccounts,
} from './setup-accounts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'plugins/gmail-switchboard/dist/cli.js');
const marketplace = 'gmail-switchboard-local';
const plugin = `gmail-switchboard@${marketplace}`;
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

function printUsage() {
  process.stdout.write(`Gmail Switchboard setup

  ./setup --account work=you@company.com --account personal=you@gmail.com
  ./setup --reauth
  ./setup --doctor
  ./setup --uninstall

Repeat --account as many times as you need.
`);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? result.stderr.trim() : '';
    throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function json(command, commandArgs, options = {}) {
  const result = run(command, commandArgs, { capture: true, ...options });
  if (!result.stdout.trim()) return null;
  return JSON.parse(result.stdout);
}

async function ask(question) {
  if (!stdin.isTTY || !stdout.isTTY) return '';
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    return (await reader.question(question)).trim();
  } finally {
    reader.close();
  }
}

function open(url) {
  if (process.platform !== 'darwin') return;
  const child = spawn('/usr/bin/open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

function hasCodexMarketplace() {
  const listing = json('codex', ['plugin', 'marketplace', 'list', '--json']);
  return listing.marketplaces.some((item) => item.name === marketplace);
}

function hasClaudeMarketplace() {
  const listing = json('claude', ['plugin', 'marketplace', 'list', '--json']);
  return listing.some((item) => item.name === marketplace);
}

function installPlugins() {
  process.stdout.write('\nInstalling the Codex plugin…\n');
  if (!hasCodexMarketplace()) {
    run('codex', ['plugin', 'marketplace', 'add', root, '--json']);
  }
  run('codex', ['plugin', 'remove', plugin, '--json'], { allowFailure: true, capture: true });
  run('codex', ['plugin', 'add', plugin, '--json']);

  process.stdout.write('\nInstalling the Claude Code plugin…\n');
  if (!hasClaudeMarketplace()) {
    run('claude', ['plugin', 'marketplace', 'add', root, '--scope', 'user']);
  }
  run('claude', ['plugin', 'uninstall', plugin, '--scope', 'user', '--yes'], {
    allowFailure: true,
    capture: true,
  });
  run('claude', ['plugin', 'install', plugin, '--scope', 'user']);
}

function uninstallPlugins() {
  process.stdout.write('Removing Gmail Switchboard from Codex and Claude Code…\n');
  run('codex', ['plugin', 'remove', plugin, '--json'], { allowFailure: true, capture: true });
  run('claude', ['plugin', 'uninstall', plugin, '--scope', 'user', '--yes'], {
    allowFailure: true,
    capture: true,
  });
  run('codex', ['plugin', 'marketplace', 'remove', marketplace], {
    allowFailure: true,
    capture: true,
  });
  run('claude', ['plugin', 'marketplace', 'remove', marketplace], {
    allowFailure: true,
    capture: true,
  });
}

async function ensureOAuthClient() {
  const status = json('node', [cli, 'client', 'status', '--json'], { allowFailure: true });
  if (status?.configured) return;

  process.stdout.write(`
Google requires one manual prerequisite:
1. Open Google Cloud Console and enable the Gmail API.
2. Configure the OAuth consent screen. If the app is in testing, add every Gmail address you plan to connect as a test user.
3. Create an OAuth client with application type “Desktop app”.
4. Download the JSON file. It will be moved into Keychain and deleted after a successful import.

`);
  open('https://console.cloud.google.com/apis/credentials');
  const path = await ask('Path to the downloaded Desktop OAuth JSON: ');
  if (!path) {
    throw new Error('OAuth setup needs the downloaded Desktop client JSON. Rerun ./setup when it is ready.');
  }
  run('node', [cli, 'client', 'set', path, '--delete-source']);
}

function accountListing() {
  const listing = json('node', [cli, 'auth', 'list', '--json'], { allowFailure: true });
  return listing?.accounts ?? [];
}

async function promptForAccounts() {
  const accounts = [];
  while (true) {
    const email = await ask('Gmail address (leave blank when done): ');
    if (!email) break;
    const alias = await ask(`Short alias for ${email}: `);
    accounts.push(parseAccountSpec(`${alias}=${email}`));
  }
  return requestedAccounts(accounts.flatMap((account) => ['--account', `${account.alias}=${account.email}`]));
}

async function ensureAccounts(requested, forceReauth = false) {
  let current = accountListing();
  let desired = requested;
  if (current.length === 0 && desired.length === 0) {
    if (!stdin.isTTY || !stdout.isTTY) {
      throw new Error('No Gmail accounts are configured. Rerun with --account alias=email, repeating the flag for every account.');
    }
    desired = await promptForAccounts();
    if (desired.length === 0) {
      throw new Error('Add at least one Gmail account. Rerun with --account alias=email, repeating the flag for every account.');
    }
  }

  const handled = new Set();
  for (const account of desired) {
    const matchingAlias = assertAccountRequestAvailable(account, current);
    if (matchingAlias) {
      if (forceReauth || matchingAlias.status !== 'connected') {
        run('node', [cli, 'auth', 'reauth', account.alias]);
      }
      matchingAlias.status = 'connected';
    } else {
      run('node', [cli, 'auth', 'add', account.alias, account.email]);
      current.push({ ...account, status: 'connected' });
    }
    handled.add(account.alias);
  }

  for (const account of current) {
    const shouldReconnect = forceReauth
      || (desired.length === 0 && account.status === 'needs_auth');
    if (!handled.has(account.alias) && shouldReconnect) {
      run('node', [cli, 'auth', 'reauth', account.alias]);
    }
  }
}

function printInstallStatus() {
  const codex = json('codex', ['plugin', 'list', '--json']);
  const claude = run('claude', ['plugin', 'list'], { capture: true }).stdout;
  const codexInstalled = codex.installed.some((item) => item.pluginId === plugin);
  const claudeInstalled = claude.includes(plugin);
  process.stdout.write(`Codex plugin: ${codexInstalled ? 'installed' : 'missing'}\n`);
  process.stdout.write(`Claude Code plugin: ${claudeInstalled ? 'installed' : 'missing'}\n`);
  if (!codexInstalled || !claudeInstalled) process.exitCode = 2;
}

async function main() {
  if (args.has('--help') || args.has('-h')) {
    printUsage();
    return;
  }

  if (args.has('--doctor')) {
    printInstallStatus();
    run('node', [cli, 'doctor']);
    return;
  }

  if (args.has('--uninstall')) {
    uninstallPlugins();
    const answer = await ask('Also revoke Gmail access and delete credentials from Keychain? [y/N] ');
    if (/^y(?:es)?$/i.test(answer)) run('node', [cli, 'purge', '--yes']);
    else process.stdout.write('Credentials were left in Keychain. Run ./gmail-switchboard purge to remove them later.\n');
    return;
  }

  const requested = requestedAccounts(rawArgs);
  installPlugins();
  await ensureOAuthClient();
  await ensureAccounts(requested, args.has('--reauth'));
  run('node', [cli, 'doctor']);
  printInstallStatus();

  process.stdout.write(`
Done. Start a fresh Codex or Claude Code thread and try:

  Find the latest email from GitHub across all my accounts.
  Search one Gmail account by the alias I gave it.
  Find receipts from the last month across every inbox.

Email access is read-only. Every result keeps its account alias.
`);
}

main().catch((error) => {
  process.stderr.write(`Setup stopped: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
