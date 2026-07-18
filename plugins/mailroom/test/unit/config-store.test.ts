import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../../src/storage/config-store.js';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function store(): Promise<ConfigStore> {
  const directory = await mkdtemp(join(tmpdir(), 'mailroom-test-'));
  const path = join(directory, 'nested', 'accounts.json');
  directories.push(directory);
  return new ConfigStore(path);
}

describe('ConfigStore', () => {
  it('stores only aliases and normalized emails with private permissions', async () => {
    const config = await store();
    await config.upsert({ alias: 'work', email: 'Work@Example.com' });
    expect(await config.list()).toEqual([{ alias: 'work', email: 'work@example.com' }]);
    expect((await stat(config.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(config.path, 'utf8')).not.toContain('token');
  });

  it('rejects duplicate emails under different aliases', async () => {
    const config = await store();
    await config.upsert({ alias: 'work', email: 'jacob@example.com' });
    await expect(config.upsert({ alias: 'other', email: 'jacob@example.com' })).rejects.toThrow();
  });

  it('does not impose a fixed account limit', async () => {
    const config = await store();
    for (let index = 0; index < 50; index += 1) {
      await config.upsert({ alias: `account-${index}`, email: `user-${index}@example.com` });
    }
    expect(await config.list()).toHaveLength(50);
  });

  it('removes accounts idempotently', async () => {
    const config = await store();
    await config.upsert({ alias: 'work', email: 'jacob@example.com' });
    expect(await config.remove('work')).toBe(true);
    expect(await config.remove('work')).toBe(false);
  });

  it('clears only the config file', async () => {
    const config = await store();
    const sibling = join(dirname(config.path), 'keep.txt');
    await config.upsert({ alias: 'work', email: 'jacob@example.com' });
    await writeFile(sibling, 'keep');

    await config.clear();

    expect(await config.list()).toEqual([]);
    expect(await readFile(sibling, 'utf8')).toBe('keep');
  });

  it('migrates the legacy config file once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mailroom-migration-'));
    directories.push(directory);
    const current = join(directory, 'mailroom', 'accounts.json');
    const legacy = join(directory, 'gmail-switchboard', 'accounts.json');
    const legacyStore = new ConfigStore(legacy, null);
    await legacyStore.upsert({ alias: 'work', email: 'work@example.com' });

    const config = new ConfigStore(current, legacy);

    expect(await config.list()).toEqual([{ alias: 'work', email: 'work@example.com' }]);
    expect(await readFile(current, 'utf8')).toContain('work@example.com');
    await expect(readFile(legacy, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
