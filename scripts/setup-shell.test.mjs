import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const setupScript = resolve(import.meta.dirname, '..', 'setup');
const mailroomScript = resolve(import.meta.dirname, '..', 'mailroom');
const fixtures = [];

async function executable(path, source) {
  await writeFile(path, `#!/bin/sh\n${source}`, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function fixture({ pnpm = 'working', corepack = 'working' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mailroom-setup-shell-'));
  fixtures.push(directory);
  const bin = join(directory, 'bin');
  const log = join(directory, 'calls.log');
  await mkdir(bin);
  await writeFile(log, '');

  await executable(join(bin, 'node'), `
if [ "$1" = "-p" ]; then
  printf '26\\n'
else
  printf 'node %s\\n' "$*" >> "$MAILROOM_SETUP_SHELL_LOG"
fi
`);
  await executable(join(bin, 'pnpm'), pnpm === 'working' ? `
if [ "$1" = "--version" ]; then
  printf '11.9.0\\n'
else
  printf 'pnpm %s\\n' "$*" >> "$MAILROOM_SETUP_SHELL_LOG"
fi
` : 'exit 1\n');
  await executable(join(bin, 'corepack'), corepack === 'working' ? `
if [ "$2" = "--version" ]; then
  printf '11.9.0\\n'
else
  printf 'corepack %s\\n' "$*" >> "$MAILROOM_SETUP_SHELL_LOG"
fi
` : 'exit 1\n');
  await executable(join(bin, 'npx'), `
printf 'npx %s\\n' "$*" >> "$MAILROOM_SETUP_SHELL_LOG"
`);
  await executable(join(bin, 'uname'), `
printf 'Linux\\n'
`);
  await executable(join(bin, 'codex'), `
if [ "$1" = "--version" ]; then
  printf 'codex-test\\n'
fi
`);

  return { bin, directory, log };
}

function runSetup(current, { args = ['--doctor'], forceBootstrap = true } = {}) {
  return spawnSync('/bin/bash', [setupScript, ...args], {
    encoding: 'utf8',
    env: {
      HOME: current.directory,
      MAILROOM_SETUP_SHELL_LOG: current.log,
      MAILROOM_SETUP_FORCE_BOOTSTRAP: forceBootstrap ? '1' : '0',
      PATH: `${current.bin}:/usr/bin:/bin`,
    },
  });
}

function runMailroom(current) {
  return spawnSync('/bin/bash', [mailroomScript, 'doctor'], {
    encoding: 'utf8',
    env: {
      HOME: current.directory,
      MAILROOM_SETUP_SHELL_LOG: current.log,
      PATH: `${current.bin}:/usr/bin:/bin`,
    },
  });
}

test.afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (directory) => (
    await rm(directory, { recursive: true, force: true })
  )));
});

test('uses a working pnpm command for install and build', async () => {
  const current = await fixture();
  const result = runSetup(current);

  assert.equal(result.status, 0, result.stderr);
  const calls = await readFile(current.log, 'utf8');
  assert.match(calls, /pnpm install --frozen-lockfile/);
  assert.match(calls, /pnpm build/);
  assert.match(calls, /node .*scripts\/setup\.mjs --doctor/);
});

test('skips install and build for doctor when the existing build is current', async () => {
  const current = await fixture();
  const result = runSetup(current, { forceBootstrap: false });

  assert.equal(result.status, 0, result.stderr);
  const calls = await readFile(current.log, 'utf8');
  assert.doesNotMatch(calls, /pnpm install/);
  assert.doesNotMatch(calls, /pnpm build/);
  assert.match(calls, /node .*scripts\/setup\.mjs --doctor/);
});

test('skips install and build for uninstall when the existing build is current', async () => {
  const current = await fixture();
  const result = runSetup(current, { args: ['--uninstall'], forceBootstrap: false });

  assert.equal(result.status, 0, result.stderr);
  const calls = await readFile(current.log, 'utf8');
  assert.doesNotMatch(calls, /pnpm (?:install|build)/);
  assert.match(calls, /node .*scripts\/setup\.mjs --uninstall/);
});

test('uses Corepack when the pnpm shim is broken', async () => {
  const current = await fixture({ pnpm: 'broken' });
  const result = runSetup(current);

  assert.equal(result.status, 0, result.stderr);
  const calls = await readFile(current.log, 'utf8');
  assert.match(calls, /corepack pnpm@11\.9\.0 install --frozen-lockfile/);
  assert.match(calls, /corepack pnpm@11\.9\.0 build/);
  assert.doesNotMatch(calls, /npx /);
});

test('uses npx when pnpm and Corepack are unavailable', async () => {
  const current = await fixture({ pnpm: 'broken', corepack: 'broken' });
  const result = runSetup(current);

  assert.equal(result.status, 0, result.stderr);
  const calls = await readFile(current.log, 'utf8');
  assert.match(calls, /npx --yes pnpm@11\.9\.0 install --frozen-lockfile/);
  assert.match(calls, /npx --yes pnpm@11\.9\.0 build/);
});

test('keeps an existing Node 22+ runtime for the Mailroom launcher', async () => {
  const current = await fixture();
  const result = runMailroom(current);

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    await readFile(current.log, 'utf8'),
    /node .*plugins\/mailroom\/dist\/cli\.js doctor/,
  );
});
