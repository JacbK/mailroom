import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertAccountRequestAvailable,
  parseAccountSpec,
  requestedAccounts,
} from './setup-accounts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cursorConfig = process.env.MAILROOM_SETUP_TEST === '1'
  && process.env.MAILROOM_SETUP_CURSOR_CONFIG
  ? resolve(process.env.MAILROOM_SETUP_CURSOR_CONFIG)
  : join(homedir(), '.cursor', 'mcp.json');
const cursorServer = resolve(root, 'plugins/mailroom/dist/server.js');
const cli = process.env.MAILROOM_SETUP_TEST === '1' && process.env.MAILROOM_SETUP_CLI
  ? resolve(process.env.MAILROOM_SETUP_CLI)
  : resolve(root, 'plugins/mailroom/dist/cli.js');
const marketplace = 'mailroom-local';
const plugin = `mailroom@${marketplace}`;
const legacyMarketplace = 'gmail-switchboard-local';
const legacyPlugin = `gmail-switchboard@${legacyMarketplace}`;
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const personalSetupUrl = 'https://mailroom.jacobkieser.me/google.html';
const downloadsDirectory = process.env.MAILROOM_SETUP_TEST === '1'
  && process.env.MAILROOM_SETUP_DOWNLOADS
  ? resolve(process.env.MAILROOM_SETUP_DOWNLOADS)
  : join(homedir(), 'Downloads');
const personalWaitMs = process.env.MAILROOM_SETUP_TEST === '1'
  ? Number(process.env.MAILROOM_SETUP_PERSONAL_WAIT_MS ?? 0)
  : 15 * 60 * 1_000;

function optionValue(name, valueDescription = 'a value') {
  const inline = rawArgs.filter((value) => value.startsWith(`${name}=`));
  const separate = rawArgs.flatMap((value, index) => value === name ? [index] : []);
  if (inline.length + separate.length > 1) {
    throw new Error(`${name} can only be supplied once.`);
  }
  if (inline.length === 1) {
    const value = inline[0].slice(name.length + 1);
    if (!value) throw new Error(`${name} needs ${valueDescription}.`);
    return value;
  }
  if (separate.length === 0) return null;
  const value = rawArgs[separate[0] + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs ${valueDescription}.`);
  return value;
}

function validateArguments() {
  const standalone = new Set(['--personal', '--shared', '--reauth', '--doctor', '--uninstall', '--help', '-h']);
  const withValues = new Set(['--account', '--self-host']);
  for (let index = 0; index < rawArgs.length; index += 1) {
    const value = rawArgs[index];
    if (standalone.has(value)) continue;
    if (withValues.has(value)) {
      const next = rawArgs[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${value} needs a value.`);
      index += 1;
      continue;
    }
    if (value.startsWith('--account=') || value.startsWith('--self-host=')) continue;
    throw new Error(`Unknown setup option "${value}". Run ./setup --help.`);
  }

  const oneShot = ['--doctor', '--uninstall', '--help', '-h'].filter((name) => args.has(name));
  if (oneShot.length > 1) {
    throw new Error('Choose only one of --doctor, --uninstall, or --help.');
  }
  if (oneShot.length === 1 && rawArgs.length > 1) {
    throw new Error(`${oneShot[0]} cannot be combined with other setup options.`);
  }

  const oauthModes = [
    args.has('--personal') ? '--personal' : null,
    args.has('--shared') ? '--shared' : null,
    optionValue('--self-host', 'a Google OAuth JSON file path') ? '--self-host' : null,
  ].filter(Boolean);
  if (oauthModes.length > 1) {
    throw new Error('Choose only one of --personal, --shared, or --self-host.');
  }
}

function printUsage() {
  process.stdout.write(`Mailroom setup

  ./setup --account work=you@company.com --account personal=you@gmail.com
  ./setup
  ./setup --personal
  ./setup --self-host /path/to/google-oauth.json
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

function canonicalPath(path) {
  if (!path) return null;
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function samePath(left, right) {
  return canonicalPath(left) === canonicalPath(right);
}

function cursorAvailable() {
  return commandExists('cursor-agent') || existsSync('/Applications/Cursor.app');
}

function cursorConfiguration() {
  if (!existsSync(cursorConfig)) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(readFileSync(cursorConfig, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    if (parsed.mcpServers !== undefined && (
      !parsed.mcpServers
      || typeof parsed.mcpServers !== 'object'
      || Array.isArray(parsed.mcpServers)
    )) throw new Error();
    return parsed;
  } catch {
    throw new Error(`Cursor MCP configuration is invalid at ${cursorConfig}. Fix its JSON, then rerun ./setup.`);
  }
}

function writeCursorConfiguration(config) {
  mkdirSync(dirname(cursorConfig), { recursive: true, mode: 0o700 });
  const temporary = `${cursorConfig}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, cursorConfig);
}

function cursorMailroomEntry() {
  return cursorConfiguration().mcpServers?.mailroom ?? null;
}

function cursorMcpCurrent() {
  const entry = cursorMailroomEntry();
  return typeof entry?.command === 'string'
    && Array.isArray(entry.args)
    && entry.args.length === 1
    && samePath(entry.args[0], cursorServer);
}

function installCursorMcp() {
  const config = cursorConfiguration();
  writeCursorConfiguration({
    ...config,
    mcpServers: {
      ...(config.mcpServers ?? {}),
      mailroom: {
        command: process.execPath,
        args: [cursorServer],
      },
    },
  });
}

function removeCursorMcp() {
  if (!existsSync(cursorConfig)) return;
  const config = cursorConfiguration();
  if (!config.mcpServers?.mailroom) return;
  const mcpServers = { ...config.mcpServers };
  delete mcpServers.mailroom;
  writeCursorConfiguration({ ...config, mcpServers });
}

function codexMarketplaceEntry() {
  const listing = json('codex', ['plugin', 'marketplace', 'list', '--json']);
  return listing.marketplaces.find((item) => item.name === marketplace) ?? null;
}

function claudeMarketplaceEntry() {
  const listing = json('claude', ['plugin', 'marketplace', 'list', '--json']);
  return listing.find((item) => item.name === marketplace) ?? null;
}

function codexMarketplacePath(entry) {
  return entry?.marketplaceSource?.source ?? entry?.root ?? null;
}

function claudeMarketplacePath(entry) {
  return entry?.path ?? (entry?.source === 'directory' ? entry?.installLocation : null) ?? null;
}

function ensureCodexMarketplace() {
  const entry = codexMarketplaceEntry();
  if (entry && !samePath(codexMarketplacePath(entry), root)) {
    process.stdout.write('Updating the Codex marketplace path…\n');
    run('codex', ['plugin', 'remove', plugin, '--json'], { allowFailure: true, capture: true });
    run('codex', ['plugin', 'marketplace', 'remove', marketplace], {
      allowFailure: true,
      capture: true,
    });
  }
  if (!entry || !samePath(codexMarketplacePath(entry), root)) {
    run('codex', ['plugin', 'marketplace', 'add', root, '--json']);
  }
}

function ensureClaudeMarketplace() {
  const entry = claudeMarketplaceEntry();
  if (entry && !samePath(claudeMarketplacePath(entry), root)) {
    process.stdout.write('Updating the Claude Code marketplace path…\n');
    run('claude', ['plugin', 'uninstall', plugin, '--scope', 'user', '--yes'], {
      allowFailure: true,
      capture: true,
    });
    run('claude', ['plugin', 'marketplace', 'remove', marketplace], {
      allowFailure: true,
      capture: true,
    });
  }
  if (!entry || !samePath(claudeMarketplacePath(entry), root)) {
    run('claude', ['plugin', 'marketplace', 'add', root, '--scope', 'user']);
  }
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
  const hasCursor = cursorAvailable();
  if (!hasCodex && !hasClaude && !hasCursor) {
    throw new Error('Install Codex, Claude Code, or Cursor, then rerun ./setup.');
  }
  removeLegacyPlugin();
  if (hasCodex) {
    process.stdout.write('\nInstalling the Codex plugin…\n');
    ensureCodexMarketplace();
    run('codex', ['plugin', 'remove', plugin, '--json'], { allowFailure: true, capture: true });
    run('codex', ['plugin', 'add', plugin, '--json']);
  }

  if (hasClaude) {
    process.stdout.write('\nInstalling the Claude Code plugin…\n');
    ensureClaudeMarketplace();
    run('claude', ['plugin', 'uninstall', plugin, '--scope', 'user', '--yes'], {
      allowFailure: true,
      capture: true,
    });
    run('claude', ['plugin', 'install', plugin, '--scope', 'user']);
  }

  if (hasCursor) {
    process.stdout.write('\nInstalling the Cursor MCP…\n');
    installCursorMcp();
  }
}

function uninstallPlugins() {
  process.stdout.write('Removing Mailroom from Codex, Claude Code, and Cursor…\n');
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
  removeCursorMcp();
  removeLegacyPlugin();
}

function validPersonalClient(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.installed
    && typeof value.installed === 'object'
    && typeof value.installed.client_id === 'string'
    && value.installed.client_id.endsWith('.apps.googleusercontent.com')
    && typeof value.installed.client_secret === 'string'
    && value.installed.client_secret.length > 0,
  );
}

async function personalClientCandidates(notBefore) {
  let entries;
  try {
    entries = await readdir(downloadsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^client_secret.*\.json$/i.test(entry.name)) continue;
    const path = join(downloadsDirectory, entry.name);
    try {
      const [metadata, parsed] = await Promise.all([
        stat(path),
        readFile(path, 'utf8').then(JSON.parse),
      ]);
      if (metadata.mtimeMs >= notBefore && validPersonalClient(parsed)) {
        candidates.push({ path, modified: metadata.mtimeMs });
      }
    } catch {
      // Ignore unrelated or partially downloaded JSON files.
    }
  }
  return candidates.sort((left, right) => right.modified - left.modified);
}

function openPersonalSetupGuide() {
  process.stdout.write([
    'Mailroom needs a personal Google app. This keeps full Gmail access free and under your control.',
    `Setup guide: ${personalSetupUrl}`,
    '',
  ].join('\n'));
  if (process.env.MAILROOM_SETUP_TEST === '1') return;
  spawnSync('/usr/bin/open', [personalSetupUrl], { stdio: 'ignore' });
}

async function waitForPersonalClient() {
  const started = Date.now();
  const recent = await personalClientCandidates(started - 5 * 60 * 1_000);
  if (recent.length === 1) return recent[0].path;
  if (recent.length > 1) {
    throw new Error('More than one recent Google OAuth download was found. Rerun with --self-host /path/to/client_secret.json.');
  }

  openPersonalSetupGuide();
  if (personalWaitMs > 0) {
    process.stdout.write('Waiting for the Desktop OAuth JSON to appear in Downloads…\n');
  }
  const deadline = started + personalWaitMs;
  while (Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(2_000, deadline - Date.now())));
    const found = await personalClientCandidates(started);
    if (found.length === 1) return found[0].path;
    if (found.length > 1) {
      throw new Error('More than one new Google OAuth download was found. Rerun with --self-host /path/to/client_secret.json.');
    }
  }
  throw new Error(`Download the Desktop OAuth JSON using ${personalSetupUrl}, then rerun ./setup --personal. You can also use ./setup --self-host /path/to/client_secret.json.`);
}

async function enablePersonalClient() {
  const path = await waitForPersonalClient();
  process.stdout.write(`Google OAuth: importing ${path.replace(`${homedir()}/`, '~/')}\n`);
  run(process.execPath, [cli, 'client', 'set', path, '--delete-source']);
}

async function ensureOAuthClient() {
  const selfHosted = optionValue('--self-host', 'a Google OAuth JSON file path');
  if (selfHosted) {
    run(process.execPath, [cli, 'client', 'set', selfHosted, '--delete-source']);
  } else if (args.has('--personal')) {
    const status = json(process.execPath, [cli, 'client', 'status', '--json'], { allowFailure: true });
    if (status?.ok && status.mode === 'self-hosted') {
      process.stdout.write('Google OAuth: personal app\n');
      return;
    }
    await enablePersonalClient();
  } else if (args.has('--shared')) {
    process.stdout.write('Warning: the shared Mailroom Google app is legacy and may stop accepting sign-ins. Use ./setup --personal instead.\n');
    run(process.execPath, [cli, 'client', 'shared']);
  } else {
    const status = json(process.execPath, [cli, 'client', 'status', '--json'], { allowFailure: true });
    if (!status?.ok) {
      await enablePersonalClient();
      return;
    }
    process.stdout.write(`Google OAuth: ${status.mode === 'shared' ? 'legacy shared app — run ./setup --personal to migrate' : 'personal app'}\n`);
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
    const shouldReconnect = desired.length === 0
      && (forceReauth || account.status === 'needs_auth');
    if (!handled.has(account.alias) && shouldReconnect) {
      run(process.execPath, [cli, 'auth', 'reauth', account.alias]);
    }
  }
}

function printInstallStatus() {
  let healthy = false;
  if (commandExists('codex')) {
    const codex = json('codex', ['plugin', 'list', '--json']);
    const entry = codex.installed.find((item) => item.pluginId === plugin);
    const installed = Boolean(entry);
    const enabled = entry?.enabled !== false;
    const marketplaceCurrent = samePath(codexMarketplacePath(codexMarketplaceEntry()), root);
    const ok = installed && enabled && marketplaceCurrent;
    const status = !installed
      ? 'missing'
      : !enabled
        ? 'disabled'
        : marketplaceCurrent
          ? 'installed'
          : 'wrong marketplace path';
    process.stdout.write(`Codex plugin: ${status}\n`);
    healthy ||= ok;
    if (!ok) process.exitCode = 2;
  }
  if (commandExists('claude')) {
    const claude = json('claude', ['plugin', 'list', '--json']);
    const entry = claude.find((item) => item.id === plugin);
    const installed = Boolean(entry);
    const enabled = entry?.enabled !== false;
    const marketplaceCurrent = samePath(claudeMarketplacePath(claudeMarketplaceEntry()), root);
    const ok = installed && enabled && marketplaceCurrent;
    const status = !installed
      ? 'missing'
      : !enabled
        ? 'disabled'
        : marketplaceCurrent
          ? 'installed'
          : 'wrong marketplace path';
    process.stdout.write(`Claude Code plugin: ${status}\n`);
    healthy ||= ok;
    if (!ok) process.exitCode = 2;
  }
  if (cursorAvailable() || cursorMailroomEntry()) {
    const ok = cursorMcpCurrent();
    process.stdout.write(`Cursor MCP: ${ok ? 'installed' : 'missing or stale'}\n`);
    healthy ||= ok;
    if (!ok) process.exitCode = 2;
  }
  if (!healthy) process.exitCode = 2;
}

async function main() {
  validateArguments();

  if (args.has('--help') || args.has('-h')) {
    printUsage();
    return;
  }

  if (args.has('--doctor')) {
    process.stdout.write('Checking Mailroom…\n');
    printInstallStatus();
    const result = run(process.execPath, [cli, 'doctor'], { allowFailure: true });
    if (result.status !== 0) process.exitCode = result.status ?? 2;
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
  process.stdout.write('[1/4] Installing the plugin\n');
  installPlugins();
  process.stdout.write('\n[2/4] Checking Google OAuth\n');
  await ensureOAuthClient();
  process.stdout.write('\n[3/4] Connecting Gmail accounts\n');
  await ensureAccounts(requested, args.has('--reauth'));
  process.stdout.write('\n[4/4] Verifying the installation\n');
  run(process.execPath, [cli, 'doctor']);
  printInstallStatus();

  process.stdout.write('\nDone. Start a new Codex, Claude Code, or Cursor task.\n');
}

main().catch((error) => {
  process.stderr.write(`Setup stopped: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
