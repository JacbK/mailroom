import { spawnSync } from 'node:child_process';
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
const cli = process.env.MAILROOM_SETUP_TEST === '1' && process.env.MAILROOM_SETUP_CLI
  ? resolve(process.env.MAILROOM_SETUP_CLI)
  : resolve(root, 'plugins/mailroom/dist/cli.js');
const marketplace = 'mailroom-local';
const plugin = `mailroom@${marketplace}`;
const legacyMarketplace = 'gmail-switchboard-local';
const legacyPlugin = `gmail-switchboard@${legacyMarketplace}`;
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

function optionValue(name) {
  const inline = rawArgs.find((value) => value.startsWith(`${name}=`));
  const index = rawArgs.indexOf(name);
  if (inline && index !== -1) throw new Error(`${name} can only be supplied once.`);
  if (inline) return inline.slice(name.length + 1);
  if (index === -1) return null;
  const value = rawArgs[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a file path.`);
  return value;
}

function printUsage() {
  process.stdout.write(`Mailroom setup

  ./setup --account work=you@company.com --account personal=you@gmail.com
  ./setup --self-host /path/to/google-oauth.json
  ./setup --shared
  ./setup --reauth
  ./setup --doctor
  ./setup --uninstall

Repeat --account as many times as you need.
`);
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', stdio: 'ignore' });
  return result.status === 0;
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

function hasCodexMarketplace() {
  const listing = json('codex', ['plugin', 'marketplace', 'list', '--json']);
  return listing.marketplaces.some((item) => item.name === marketplace);
}

function hasClaudeMarketplace() {
  const listing = json('claude', ['plugin', 'marketplace', 'list', '--json']);
  return listing.some((item) => item.name === marketplace);
}

function removeLegacyPlugin() {
  if (commandExists('codex')) {
    run('codex', ['plugin', 'remove', legacyPlugin, '--json'], { allowFailure: true, capture: true });
    run('codex', ['plugin', 'marketplace', 'remove', legacyMarketplace], {
      allowFailure: true,
      capture: true,
    });
  }
  if (commandExists('claude')) {
    run('claude', ['plugin', 'uninstall', legacyPlugin, '--scope', 'user', '--yes'], {
      allowFailure: true,
      capture: true,
    });
    run('claude', ['plugin', 'marketplace', 'remove', legacyMarketplace], {
      allowFailure: true,
      capture: true,
    });
  }
}

function installPlugins() {
  const hasCodex = commandExists('codex');
  const hasClaude = commandExists('claude');
  if (!hasCodex && !hasClaude) {
    throw new Error('Install Codex or Claude Code, then rerun ./setup.');
  }
  removeLegacyPlugin();
  if (hasCodex) {
    process.stdout.write('\nInstalling the Codex plugin…\n');
    if (!hasCodexMarketplace()) {
      run('codex', ['plugin', 'marketplace', 'add', root, '--json']);
    }
    run('codex', ['plugin', 'remove', plugin, '--json'], { allowFailure: true, capture: true });
    run('codex', ['plugin', 'add', plugin, '--json']);
  }

  if (hasClaude) {
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
}

function uninstallPlugins() {
  process.stdout.write('Removing Mailroom from Codex and Claude Code…\n');
  if (commandExists('codex')) {
    run('codex', ['plugin', 'remove', plugin, '--json'], { allowFailure: true, capture: true });
    run('codex', ['plugin', 'marketplace', 'remove', marketplace], {
      allowFailure: true,
      capture: true,
    });
  }
  if (commandExists('claude')) {
    run('claude', ['plugin', 'uninstall', plugin, '--scope', 'user', '--yes'], {
      allowFailure: true,
      capture: true,
    });
    run('claude', ['plugin', 'marketplace', 'remove', marketplace], {
      allowFailure: true,
      capture: true,
    });
  }
  removeLegacyPlugin();
}

function ensureOAuthClient() {
  const selfHosted = optionValue('--self-host');
  if (selfHosted && args.has('--shared')) {
    throw new Error('Choose either --shared or --self-host, not both.');
  }
  if (selfHosted) {
    run(process.execPath, [cli, 'client', 'set', selfHosted, '--delete-source']);
  } else if (args.has('--shared')) {
    run(process.execPath, [cli, 'client', 'shared']);
  } else {
    const status = json(process.execPath, [cli, 'client', 'status', '--json'], { allowFailure: true });
    if (!status?.ok) {
      throw new Error('Google OAuth needs repair. Run ./setup --shared or ./setup --self-host <oauth-json>.');
    }
    process.stdout.write(`Google OAuth: ${status.mode === 'shared' ? 'Mailroom shared app' : 'self-hosted app'}\n`);
  }
}

function accountListing() {
  const listing = json(process.execPath, [cli, 'auth', 'list', '--json'], { allowFailure: true });
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
        run(process.execPath, [cli, 'auth', 'reauth', account.alias]);
      }
      matchingAlias.status = 'connected';
    } else {
      run(process.execPath, [cli, 'auth', 'add', account.alias, account.email]);
      current.push({ ...account, status: 'connected' });
    }
    handled.add(account.alias);
  }

  for (const account of current) {
    const shouldReconnect = forceReauth
      || (desired.length === 0 && account.status === 'needs_auth');
    if (!handled.has(account.alias) && shouldReconnect) {
      run(process.execPath, [cli, 'auth', 'reauth', account.alias]);
    }
  }
}

function printInstallStatus() {
  let healthy = false;
  if (commandExists('codex')) {
    const codex = json('codex', ['plugin', 'list', '--json']);
    const installed = codex.installed.some((item) => item.pluginId === plugin);
    process.stdout.write(`Codex plugin: ${installed ? 'installed' : 'missing'}\n`);
    healthy ||= installed;
    if (!installed) process.exitCode = 2;
  }
  if (commandExists('claude')) {
    const claude = run('claude', ['plugin', 'list'], { capture: true }).stdout;
    const installed = claude.includes(plugin);
    process.stdout.write(`Claude Code plugin: ${installed ? 'installed' : 'missing'}\n`);
    healthy ||= installed;
    if (!installed) process.exitCode = 2;
  }
  if (!healthy) process.exitCode = 2;
}

async function main() {
  if (args.has('--help') || args.has('-h')) {
    printUsage();
    return;
  }

  if (args.has('--doctor')) {
    printInstallStatus();
    run(process.execPath, [cli, 'doctor']);
    return;
  }

  if (args.has('--uninstall')) {
    uninstallPlugins();
    const answer = await ask('Also revoke Gmail access and delete credentials from Keychain? [y/N] ');
    if (/^y(?:es)?$/i.test(answer)) run(process.execPath, [cli, 'purge', '--yes']);
    else process.stdout.write('Credentials were left in Keychain. Run ./mailroom purge to remove them later.\n');
    return;
  }

  const requested = requestedAccounts(rawArgs);
  installPlugins();
  ensureOAuthClient();
  await ensureAccounts(requested, args.has('--reauth'));
  run(process.execPath, [cli, 'doctor']);
  printInstallStatus();

  process.stdout.write('\nDone. Start a new Codex or Claude Code task.\n');
}

main().catch((error) => {
  process.stderr.write(`Setup stopped: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
