import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const setupScript = resolve(import.meta.dirname, 'setup.mjs');
const repositoryRoot = resolve(import.meta.dirname, '..');
const fixtures = [];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function makeExecutable(path, source) {
  await writeFile(path, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function fixture(
  clients,
  accounts = [],
  marketplaceRoot = repositoryRoot,
  oauthHealthy = true,
  doctorHealthy = true,
) {
  const directory = await mkdtemp(join(tmpdir(), 'mailroom-setup-e2e-'));
  fixtures.push(directory);
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const log = join(directory, 'calls.log');
  const cli = join(directory, 'fake-cli.mjs');
  await writeFile(log, '');
  await makeExecutable(cli, `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.MAILROOM_SETUP_CALL_LOG, 'cli ' + args.join(' ') + '\\n');
if (args[0] === 'client' && args[1] === 'status') {
  const ok = process.env.MAILROOM_SETUP_OAUTH_HEALTHY === '1';
  process.stdout.write(JSON.stringify({ configured: ok, mode: ok ? 'shared' : null, fingerprint: ok ? '1234567890abcdef' : null, ok }) + '\\n');
} else if (args[0] === 'auth' && args[1] === 'list') {
  process.stdout.write(JSON.stringify({ accounts: JSON.parse(process.env.MAILROOM_SETUP_ACCOUNTS || '[]') }) + '\\n');
} else if (args[0] === 'doctor') {
  const healthy = process.env.MAILROOM_SETUP_DOCTOR_HEALTHY === '1';
  process.stdout.write('Overall: ' + (healthy ? 'healthy' : 'needs attention') + '\\n');
  if (!healthy) process.exitCode = 2;
}
`);
  for (const client of clients) {
    await makeExecutable(join(bin, client), `
import { appendFileSync } from 'node:fs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const host = basename(process.argv[1]);
const args = process.argv.slice(2);
const marketplaceState = process.env.MAILROOM_SETUP_MARKETPLACE_STATE + '-' + host;
const marketplaceRoot = existsSync(marketplaceState)
  ? readFileSync(marketplaceState, 'utf8')
  : process.env.MAILROOM_SETUP_MARKETPLACE_ROOT;
appendFileSync(process.env.MAILROOM_SETUP_CALL_LOG, host + ' ' + args.join(' ') + '\\n');
if (args.includes('--version')) process.stdout.write('1.0.0\\n');
else if (host === 'codex' && args.join(' ') === 'plugin marketplace list --json') {
  process.stdout.write(JSON.stringify({ marketplaces: [{ name: 'mailroom-local', root: marketplaceRoot, marketplaceSource: { sourceType: 'local', source: marketplaceRoot } }] }) + '\\n');
} else if (host === 'codex' && args.join(' ') === 'plugin list --json') {
  process.stdout.write(JSON.stringify({ installed: [{ pluginId: 'mailroom@mailroom-local' }] }) + '\\n');
} else if (host === 'claude' && args.join(' ') === 'plugin marketplace list --json') {
  process.stdout.write(JSON.stringify([{ name: 'mailroom-local', source: 'directory', path: marketplaceRoot, installLocation: marketplaceRoot }]) + '\\n');
} else if (host === 'claude' && args.join(' ') === 'plugin list --json') {
  process.stdout.write(JSON.stringify([{ id: 'mailroom@mailroom-local', enabled: true }]) + '\\n');
} else if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  writeFileSync(marketplaceState, args[3]);
}
`);
  }
  return { accounts, bin, cli, directory, doctorHealthy, log, marketplaceRoot, marketplaceState: join(directory, 'marketplace-root'), oauthHealthy };
}

function runSetup(current, args) {
  return spawnSync(process.execPath, [setupScript, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MAILROOM_SETUP_ACCOUNTS: JSON.stringify(current.accounts),
      MAILROOM_SETUP_CALL_LOG: current.log,
      MAILROOM_SETUP_CLI: current.cli,
      MAILROOM_SETUP_MARKETPLACE_ROOT: current.marketplaceRoot,
      MAILROOM_SETUP_MARKETPLACE_STATE: current.marketplaceState,
      MAILROOM_SETUP_OAUTH_HEALTHY: current.oauthHealthy ? '1' : '0',
      MAILROOM_SETUP_DOCTOR_HEALTHY: current.doctorHealthy ? '1' : '0',
      MAILROOM_SETUP_TEST: '1',
      PATH: `${current.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    },
  });
}

async function calls(current) {
  return await readFile(current.log, 'utf8');
}

test.afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (directory) => (
    await rm(directory, { recursive: true, force: true })
  )));
});

test('installs and upgrades cleanly with Codex only', async () => {
  const current = await fixture(['codex']);
  const result = runSetup(current, ['--account', 'personal=user@example.com']);

  assert.equal(result.status, 0, result.stderr);
  const log = await calls(current);
  assert.match(log, /codex plugin remove mailroom@mailroom-local/);
  assert.match(log, /codex plugin add mailroom@mailroom-local/);
  assert.match(log, /cli auth add personal user@example.com/);
  assert.doesNotMatch(log, /claude /);
  assert.match(result.stdout, /Codex plugin: installed/);
});

test('installs with Claude Code only', async () => {
  const current = await fixture(['claude']);
  const result = runSetup(current, ['--account=work=user@company.com']);

  assert.equal(result.status, 0, result.stderr);
  const log = await calls(current);
  assert.match(log, /claude plugin install mailroom@mailroom-local/);
  assert.match(log, /cli auth add work user@company.com/);
  assert.doesNotMatch(log, /codex plugin/);
  assert.match(result.stdout, /Claude Code plugin: installed/);
});

test('installs into both clients when both are present', async () => {
  const current = await fixture(['codex', 'claude']);
  const result = runSetup(current, ['--account=personal=user@example.com']);

  assert.equal(result.status, 0, result.stderr);
  const log = await calls(current);
  assert.match(log, /codex plugin add mailroom@mailroom-local/);
  assert.match(log, /claude plugin install mailroom@mailroom-local/);
});

test('repairs stale marketplace paths before installing', async () => {
  const current = await fixture(
    ['codex', 'claude'],
    [{ alias: 'personal', email: 'user@example.com', status: 'connected' }],
    '/old/mailroom',
  );
  const result = runSetup(current, []);

  assert.equal(result.status, 0, result.stderr);
  const log = await calls(current);
  assert.match(log, /codex plugin marketplace remove mailroom-local/);
  assert.match(
    log,
    new RegExp(`codex plugin marketplace add ${escapeRegExp(repositoryRoot)} --json`),
  );
  assert.match(log, /claude plugin marketplace remove mailroom-local/);
  assert.match(
    log,
    new RegExp(`claude plugin marketplace add ${escapeRegExp(repositoryRoot)} --scope user`),
  );
  assert.match(result.stdout, /Updating the Codex marketplace path/);
  assert.match(result.stdout, /Updating the Claude Code marketplace path/);
});

test('recovers an account that needs authentication', async () => {
  const current = await fixture(['codex'], [
    { alias: 'work', email: 'user@company.com', status: 'needs_auth' },
  ]);
  const result = runSetup(current, []);

  assert.equal(result.status, 0, result.stderr);
  assert.match(await calls(current), /cli auth reauth work/);
});

test('targeted reauth does not reconnect unrelated accounts', async () => {
  const current = await fixture(['codex'], [
    { alias: 'work', email: 'user@company.com', status: 'connected' },
    { alias: 'personal', email: 'user@example.com', status: 'connected' },
  ]);
  const result = runSetup(current, ['--reauth', '--account', 'work=user@company.com']);

  assert.equal(result.status, 0, result.stderr);
  const log = await calls(current);
  assert.match(log, /cli auth reauth work/);
  assert.doesNotMatch(log, /cli auth reauth personal/);
});

test('supports explicit shared and self-hosted OAuth modes', async () => {
  const shared = await fixture(['codex'], [
    { alias: 'work', email: 'user@company.com', status: 'connected' },
  ]);
  const sharedResult = runSetup(shared, ['--shared']);
  assert.equal(sharedResult.status, 0, sharedResult.stderr);
  assert.match(await calls(shared), /cli client shared/);

  const selfHosted = await fixture(['codex'], [
    { alias: 'work', email: 'user@company.com', status: 'connected' },
  ]);
  const clientPath = join(selfHosted.directory, 'oauth.json');
  await writeFile(clientPath, '{}');
  const selfHostedResult = runSetup(selfHosted, ['--self-host', clientPath]);
  assert.equal(selfHostedResult.status, 0, selfHostedResult.stderr);
  assert.match(await calls(selfHosted), new RegExp(`cli client set ${clientPath} --delete-source`));
});

test('repairs missing OAuth configuration with the shared app by default', async () => {
  const current = await fixture(
    ['claude'],
    [{ alias: 'personal', email: 'user@example.com', status: 'connected' }],
    repositoryRoot,
    false,
  );
  const result = runSetup(current, []);

  assert.equal(result.status, 0, result.stderr);
  assert.match(await calls(current), /cli client shared/);
  assert.match(result.stdout, /repairing with the Mailroom shared app/);
});

test('fails clearly when neither client is installed', async () => {
  const current = await fixture([]);
  const result = runSetup(current, ['--account=personal=user@example.com']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Install Codex or Claude Code/);
});

test('reports an unhealthy doctor result without a setup-stopped error', async () => {
  const current = await fixture(
    ['codex'],
    [],
    repositoryRoot,
    true,
    false,
  );
  const result = runSetup(current, ['--doctor']);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /Overall: needs attention/);
  assert.doesNotMatch(result.stderr, /Setup stopped/);
});

test('rejects unknown and conflicting options before changing anything', async () => {
  const unknown = await fixture(['codex']);
  const unknownResult = runSetup(unknown, ['--doctro']);
  assert.equal(unknownResult.status, 1);
  assert.match(unknownResult.stderr, /Unknown setup option/);
  assert.equal(await calls(unknown), '');

  const conflicting = await fixture(['codex']);
  const conflictingResult = runSetup(conflicting, ['--shared', '--self-host', '/tmp/oauth.json']);
  assert.equal(conflictingResult.status, 1);
  assert.match(conflictingResult.stderr, /Choose either --shared or --self-host/);
  assert.equal(await calls(conflicting), '');
});
