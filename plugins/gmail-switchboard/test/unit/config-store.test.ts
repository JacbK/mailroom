import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../../src/storage/config-store.js';

const paths: string[] = [];

afterEach(async () => {
  for (const path of paths.splice(0)) await new ConfigStore(path).clear();
});

async function store(): Promise<ConfigStore> {
  const directory = await mkdtemp(join(tmpdir(), 'gmail-switchboard-test-'));
  const path = join(directory, 'nested', 'accounts.json');
  paths.push(path);
  return new ConfigStore(path);
}

describe('ConfigStore', () => {
  it('stores only aliases and normalized emails with private permissions', async () => {
    const config = await store();
    await config.upsert({ alias: 'work', email: 'Jacob@Embrasure.ai' });
    expect(await config.list()).toEqual([{ alias: 'work', email: 'jacob@embrasure.ai' }]);
    expect((await stat(config.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(config.path, 'utf8')).not.toContain('token');
  });

  it('rejects duplicate emails under different aliases', async () => {
    const config = await store();
    await config.upsert({ alias: 'work', email: 'jacob@example.com' });
    await expect(config.upsert({ alias: 'other', email: 'jacob@example.com' })).rejects.toThrow();
  });

  it('removes accounts idempotently', async () => {
    const config = await store();
    await config.upsert({ alias: 'work', email: 'jacob@example.com' });
    expect(await config.remove('work')).toBe(true);
    expect(await config.remove('work')).toBe(false);
  });
});
