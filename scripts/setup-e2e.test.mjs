import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const setupScript = resolve(import.meta.dirname, 'setup.mjs');
const fixtures = [];

async function makeExecutable(path, source) {
  await writeFile(path, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function fixture(clients, accounts = []) {
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
  process.stdout.write(JSON.stringify({ configured: true, mode: 'shared', fingerprint: '1234567890abcdef', ok: true }) + '\\n');
} else if (args[0] === 'auth' && args[1] === 'list') {
  process.stdout.write(JSON.stringify({ accounts: JSON.parse(process.env.MAILROOM_SETUP_ACCOUNTS || '[]') }) + '\\n');
} else if (args[0] === 'doctor') {
  process.stdout.write('Overall: healthy\\n');
}
`);
  for (const client of clients) {
    await makeExecutable(join(bin, client), `
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const host = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.MAILROOM_SETUP_CALL_LOG, host + ' ' + args.join(' ') + '\\n');
if (args.includes('--version')) process.stdout.write('1.0.0\\n');
else if (host === 'codex' && args.join(' ') === 'plugin marketplace list --json') {
  process.stdout.write(JSON.stringify({ marketplaces: [{ name: 'mailroom-local' }] }) + '\\n');
} else if (host === 'codex' && args.join(' ') === 'plugin list --json') {
  process.stdout.write(JSON.stringify({ installed: [{ pluginId: 'mailroom@mailroom-local' }] }) + '\\n');
} else if (host === 'claude' && args.join(' ') === 'plugin marketplace list --json') {
  process.stdout.write(JSON.stringify([{ name: 'mailroom-local' }]) + '\\n');
} else if (host === 'claude' && args.join(' ') === 'plugin list') {
  process.stdout.write('mailroom@mailroom-local\\n');
}
`);
  }
  return { accounts, bin, cli, directory, log };
}

function runSetup(current, args) {
  return spawnSync(process.execPath, [setupScript, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MAILROOM_SETUP_ACCOUNTS: JSON.stringify(current.accounts),
      MAILROOM_SETUP_CALL_LOG: current.log,
      MAILROOM_SETUP_CLI: current.cli,
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

test('recovers an account that needs authentication', async () => {
  const current = await fixture(['codex'], [
    { alias: 'work', email: 'user@company.com', status: 'needs_auth' },
  ]);
  const result = runSetup(current, []);

  assert.equal(result.status, 0, result.stderr);
  assert.match(await calls(current), /cli auth reauth work/);
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

test('fails clearly when neither client is installed', async () => {
  const current = await fixture([]);
  const result = runSetup(current, ['--account=personal=user@example.com']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Install Codex or Claude Code/);
});
