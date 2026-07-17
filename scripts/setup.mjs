import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(root, 'plugins/gmail-switchboard/dist/cli.js');
const marketplace = 'gmail-switchboard-local';
const plugin = `gmail-switchboard@${marketplace}`;
const args = new Set(process.argv.slice(2));

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
2. Configure the OAuth consent screen. If the app is in testing, add both Gmail addresses as test users.
3. Create an OAuth client with application type “Desktop app”.
4. Download the JSON file. It will be copied into Keychain, not this repository.

`);
  open('https://console.cloud.google.com/apis/credentials');
  const path = await ask('Path to the downloaded Desktop OAuth JSON: ');
  if (!path) {
    throw new Error('OAuth setup needs the downloaded Desktop client JSON. Rerun ./setup when it is ready.');
  }
  run('node', [cli, 'client', 'set', path]);
}

function accountListing() {
  const listing = json('node', [cli, 'auth', 'list', '--json'], { allowFailure: true });
  return listing?.accounts ?? [];
}

async function ensureAccounts(forceReauth = false) {
  const expected = [
    { alias: 'work', email: 'jacob@embrasure.ai' },
    { alias: 'personal', email: 'jacobk2112@gmail.com' },
  ];
  for (const account of expected) {
    const current = accountListing().find((item) => item.alias === account.alias);
    if (!forceReauth && current?.email === account.email && current.status === 'connected') continue;
    if (forceReauth && current) {
      run('node', [cli, 'auth', 'reauth', account.alias]);
    } else {
      run('node', [cli, 'auth', 'add', account.alias, account.email]);
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

  installPlugins();
  await ensureOAuthClient();
  await ensureAccounts(args.has('--reauth'));
  run('node', [cli, 'doctor']);
  printInstallStatus();

  process.stdout.write(`
Done. Start a fresh Codex or Claude Code thread and try:

  Find the latest email from GitHub across both of my accounts.
  Search only my work Gmail for the latest AWS email.
  Search my personal Gmail for receipts from the last month.

Email access is read-only. Every result keeps its account alias.
`);
}

main().catch((error) => {
  process.stderr.write(`Setup stopped: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
