import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SwitchboardError } from '../../src/errors.js';
import { GmailService } from '../../src/gmail/service.js';
import { ConfigStore } from '../../src/storage/config-store.js';
import { FakeGateway, message } from '../helpers.js';

let config: ConfigStore;
let work: FakeGateway;
let personal: FakeGateway;
let service: GmailService;

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmail-switchboard-service-'));
  config = new ConfigStore(join(directory, 'accounts.json'));
  await config.upsert({ alias: 'work', email: 'jacob@embrasure.ai' });
  await config.upsert({ alias: 'personal', email: 'jacobk2112@gmail.com' });
  work = new FakeGateway([
    message({ id: 'w1', threadId: 'wt', date: '2026-07-10T12:00:00Z', subject: 'Work one' }),
    message({ id: 'w2', date: '2026-07-08T12:00:00Z', subject: 'Work two' }),
    message({ id: 'w3', date: '2026-07-06T12:00:00Z', subject: 'Work three' }),
  ], 2, 'jacob@embrasure.ai');
  personal = new FakeGateway([
    message({ id: 'p1', threadId: 'pt', date: '2026-07-09T12:00:00Z', subject: 'Personal one' }),
    message({ id: 'p2', date: '2026-07-07T12:00:00Z', subject: 'Personal two' }),
    message({ id: 'p3', date: '2026-07-05T12:00:00Z', subject: 'Personal three' }),
  ], 2, 'jacobk2112@gmail.com');
  const provider = async (alias: string) => ({
    account: await config.get(alias),
    gateway: alias === 'work' ? work : personal,
  });
  service = new GmailService(config, undefined, provider);
});

afterEach(async () => await config.clear());

describe('GmailService contract', () => {
  it('reports both verified account identities', async () => {
    expect(await service.accounts()).toEqual([
      { alias: 'personal', email: 'jacobk2112@gmail.com', status: 'connected' },
      { alias: 'work', email: 'jacob@embrasure.ai', status: 'connected' },
    ]);
  });

  it('searches all accounts by default and merges them chronologically', async () => {
    const page = await service.search({
      query: 'from:github.com',
      after: '2026-07-01',
      before: '2026-08-01',
      limit: 3,
    });
    expect(page.results.map((item) => item.message_id)).toEqual(['work:w1', 'personal:p1', 'work:w2']);
    expect(page.searched_accounts.map((item) => item.alias).sort()).toEqual(['personal', 'work']);
    expect(work.queries[0]).toBe('from:github.com after:2026/07/01 before:2026/08/01');
    expect(page.next_cursor).toMatch(/[0-9a-f-]{36}/);
  });

  it('continues pagination without losing buffered cross-account results', async () => {
    const first = await service.search({ limit: 2 });
    const second = await service.search({ cursor: first.next_cursor ?? undefined, limit: 2 });
    const third = await service.search({ cursor: second.next_cursor ?? undefined, limit: 2 });
    expect([
      ...first.results,
      ...second.results,
      ...third.results,
    ].map((item) => item.message_id)).toEqual([
      'work:w1', 'personal:p1', 'work:w2', 'personal:p2', 'work:w3', 'personal:p3',
    ]);
    expect(third.next_cursor).toBeNull();
  });

  it('limits a search to an explicit account', async () => {
    const page = await service.search({ accounts: ['personal'], limit: 2 });
    expect(page.results.every((item) => item.account_alias === 'personal')).toBe(true);
    expect(work.queries).toHaveLength(0);
  });

  it('rejects unknown aliases and expired cursors', async () => {
    await expect(service.search({ accounts: ['unknown'] })).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
    await expect(service.search({ cursor: '00000000-0000-4000-8000-000000000000' }))
      .rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
  });

  it('opens messages and threads only through account-qualified IDs', async () => {
    await expect(service.getMessage('w1')).rejects.toMatchObject({ code: 'AMBIGUOUS_ID' });
    const view = await service.getMessage('work:w1');
    expect(view.account_email).toBe('jacob@embrasure.ai');
    const thread = await service.getThread('work:wt');
    expect(thread.account_alias).toBe('work');
    expect(thread.messages[0]?.message_id).toBe('work:w1');
  });

  it('blocks archives and enforces attachment size limits', async () => {
    work = new FakeGateway([
      message({
        id: 'archive',
        date: '2026-07-01T00:00:00Z',
        attachment: { id: 'a1', filename: 'payload.zip', mimeType: 'application/zip', size: 20 },
      }),
      message({
        id: 'large',
        date: '2026-07-01T00:00:00Z',
        attachment: { id: 'a2', filename: 'report.pdf', mimeType: 'application/pdf', size: 2_000_000 },
      }),
    ]);
    const provider = async (alias: string) => ({ account: await config.get(alias), gateway: work });
    service = new GmailService(config, undefined, provider);
    await expect(service.getAttachment({ messageId: 'work:archive', attachmentId: 'a1' }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_BLOCKED' });
    await expect(service.getAttachment({ messageId: 'work:large', attachmentId: 'a2' }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
  });

  it('returns safe attachments with a digest and no execution', async () => {
    work = new FakeGateway([
      message({
        id: 'safe',
        date: '2026-07-01T00:00:00Z',
        attachment: { id: 'a3', filename: 'note.txt', mimeType: 'text/plain', size: 5 },
      }),
    ]);
    work.attachments.set('a3', 'hello');
    const provider = async (alias: string) => ({ account: await config.get(alias), gateway: work });
    service = new GmailService(config, undefined, provider);
    const attachment = await service.getAttachment({ messageId: 'work:safe', attachmentId: 'a3' });
    expect(Buffer.from(attachment.base64_data, 'base64').toString()).toBe('hello');
    expect(attachment.sha256).toHaveLength(64);
  });

  it('preserves structured recovery guidance on API errors', async () => {
    const failing = new FakeGateway([]);
    failing.getMessage = async () => { throw Object.assign(new Error('revoked'), { code: 401 }); };
    const provider = async (alias: string) => ({ account: await config.get(alias), gateway: failing });
    service = new GmailService(config, undefined, provider);
    await expect(service.getMessage('work:w1')).rejects.toBeInstanceOf(SwitchboardError);
  });
});
