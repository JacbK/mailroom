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

  it('distinguishes transient health failures from authentication failures', async () => {
    const provider = async (alias: string) => {
      if (alias === 'work') throw Object.assign(new Error('temporary outage'), { code: 503 });
      return { account: await config.get(alias), gateway: personal };
    };
    service = new GmailService(config, undefined, provider);

    expect(await service.accounts()).toEqual([
      { alias: 'personal', email: 'jacobk2112@gmail.com', status: 'connected' },
      { alias: 'work', email: 'jacob@embrasure.ai', status: 'error' },
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

  it('keeps global chronological order when one account crosses a page boundary', async () => {
    work = new FakeGateway([
      message({ id: 'w-new', date: '2026-07-10T00:00:00Z' }),
      message({ id: 'w-old', date: '2026-07-01T00:00:00Z' }),
    ], 2, 'jacob@embrasure.ai');
    personal = new FakeGateway([
      message({ id: 'p-new', date: '2026-07-09T00:00:00Z' }),
      message({ id: 'p-middle', date: '2026-07-08T00:00:00Z' }),
      message({ id: 'p-next-page', date: '2026-07-07T00:00:00Z' }),
    ], 2, 'jacobk2112@gmail.com');
    const provider = async (alias: string) => ({
      account: await config.get(alias),
      gateway: alias === 'work' ? work : personal,
    });
    service = new GmailService(config, undefined, provider);

    const first = await service.search({ limit: 2 });
    const second = await service.search({ cursor: first.next_cursor ?? undefined, limit: 2 });
    expect([...first.results, ...second.results].map((item) => item.message_id)).toEqual([
      'work:w-new',
      'personal:p-new',
      'personal:p-middle',
      'personal:p-next-page',
    ]);
  });

  it('preserves duplicate raw Gmail IDs from different accounts', async () => {
    work = new FakeGateway([
      message({ id: 'same', date: '2026-07-10T00:00:00Z' }),
    ], 2, 'jacob@embrasure.ai');
    personal = new FakeGateway([
      message({ id: 'same', date: '2026-07-09T00:00:00Z' }),
    ], 2, 'jacobk2112@gmail.com');
    const provider = async (alias: string) => ({
      account: await config.get(alias),
      gateway: alias === 'work' ? work : personal,
    });
    service = new GmailService(config, undefined, provider);

    const page = await service.search({ limit: 10 });
    expect(page.results.map((item) => item.message_id)).toEqual(['work:same', 'personal:same']);
  });

  it('returns an explicit empty page only when the Gmail search is truly empty', async () => {
    work = new FakeGateway([], 2, 'jacob@embrasure.ai');
    personal = new FakeGateway([], 2, 'jacobk2112@gmail.com');
    const provider = async (alias: string) => ({
      account: await config.get(alias),
      gateway: alias === 'work' ? work : personal,
    });
    service = new GmailService(config, undefined, provider);

    await expect(service.search({ query: 'from:nobody.invalid' })).resolves.toMatchObject({
      results: [],
      result_count: 0,
      next_cursor: null,
    });
  });

  it('returns an explicit partial page when duplicate Gmail pages exhaust the per-call budget', async () => {
    const repeated = message({ id: 'repeated', date: '2026-07-10T00:00:00Z' });
    work = new FakeGateway([repeated], 1, 'jacob@embrasure.ai');
    work.listMessages = async () => ({
      messages: [{ id: 'repeated' }],
      nextPageToken: 'next',
    });
    const provider = async (alias: string) => ({ account: await config.get(alias), gateway: work });
    service = new GmailService(config, undefined, provider);

    const first = await service.search({ accounts: ['work'], limit: 1 });
    const second = await service.search({ cursor: first.next_cursor ?? undefined, limit: 1 });
    expect(second).toMatchObject({
      results: [],
      partial: true,
      next_cursor: first.next_cursor,
    });
    expect(second.partial_reason).toContain('page limit');
  });

  it('does not emit older buffered results when a partial page cannot prove global order', async () => {
    const workMessage = message({ id: 'work-new', date: '2026-07-10T00:00:00Z' });
    work = new FakeGateway([workMessage], 1, 'jacob@embrasure.ai');
    work.listMessages = async () => ({
      messages: [{ id: 'work-new' }],
      nextPageToken: 'next',
    });
    personal = new FakeGateway([
      message({ id: 'personal-buffered', date: '2026-07-09T00:00:00Z' }),
    ], 1, 'jacobk2112@gmail.com');
    const provider = async (alias: string) => ({
      account: await config.get(alias),
      gateway: alias === 'work' ? work : personal,
    });
    service = new GmailService(config, undefined, provider);

    const first = await service.search({ limit: 1 });
    expect(first.results.map((item) => item.message_id)).toEqual(['work:work-new']);
    const second = await service.search({ cursor: first.next_cursor ?? undefined, limit: 1 });
    expect(second.results).toEqual([]);
    expect(second.partial).toBe(true);
    expect(second.partial_reason).toContain('chronological order');
  });

  it('rejects overlapping use of the same cursor instead of corrupting pagination state', async () => {
    work = new FakeGateway([
      message({ id: 'concurrent-1', date: '2026-07-10T00:00:00Z' }),
      message({ id: 'concurrent-2', date: '2026-07-09T00:00:00Z' }),
    ], 1, 'jacob@embrasure.ai');
    const provider = async (alias: string) => ({ account: await config.get(alias), gateway: work });
    service = new GmailService(config, undefined, provider);
    const first = await service.search({ accounts: ['work'], limit: 1 });
    const cursor = first.next_cursor;
    if (!cursor) throw new Error('Expected a pagination cursor.');

    const originalList = work.listMessages.bind(work);
    let markStarted: (() => void) | undefined;
    let releaseRequest: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseRequest = resolve; });
    work.listMessages = async (query, maxResults, pageToken) => {
      markStarted?.();
      await released;
      return await originalList(query, maxResults, pageToken);
    };

    const pending = service.search({ cursor, limit: 1 });
    await started;
    await expect(service.search({ cursor, limit: 1 })).rejects.toMatchObject({
      code: 'CURSOR_IN_USE',
    });
    releaseRequest?.();
    await expect(pending).resolves.toMatchObject({ result_count: 1 });
  });

  it('keeps an actively used cursor when the LRU reaches capacity', async () => {
    work = new FakeGateway([], 1, 'jacob@embrasure.ai');
    work.listMessages = async (_query, _maxResults, pageToken) => {
      const offset = Number(pageToken ?? 0);
      return { messages: [{ id: `cursor-${offset}` }], nextPageToken: String(offset + 1) };
    };
    work.getMessage = async (id) => message({
      id,
      date: new Date(Date.UTC(2026, 0, 1) - Number(id.slice(7)) * 1_000).toISOString(),
    });
    const provider = async (alias: string) => ({ account: await config.get(alias), gateway: work });
    service = new GmailService(config, undefined, provider);

    const cursors: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const page = await service.search({ accounts: ['work'], query: `cursor-${index}`, limit: 1 });
      if (page.next_cursor) cursors.push(page.next_cursor);
    }
    const activeCursor = cursors[0];
    if (!activeCursor) throw new Error('Expected an active cursor.');
    await expect(service.search({ cursor: activeCursor, limit: 1 })).resolves.toMatchObject({
      next_cursor: activeCursor,
    });
    await service.search({ accounts: ['work'], query: 'capacity-trigger', limit: 1 });
    await expect(service.search({ cursor: activeCursor, limit: 1 })).resolves.toMatchObject({
      next_cursor: activeCursor,
    });
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

  it('caps large threads, keeps chronological order, and reports truncation', async () => {
    const messages = Array.from({ length: 105 }, (_, index) => message({
      id: `large-${index}`,
      threadId: 'large-thread',
      date: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }));
    work = new FakeGateway(messages, 25, 'jacob@embrasure.ai');
    const provider = async (alias: string) => ({ account: await config.get(alias), gateway: work });
    service = new GmailService(config, undefined, provider);

    const thread = await service.getThread('work:large-thread');
    expect(thread.truncated).toBe(true);
    expect(thread.messages).toHaveLength(100);
    expect(thread.messages[0]?.message_id).toBe('work:large-5');
    expect(thread.messages[99]?.message_id).toBe('work:large-104');
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

  it('maps expired or revoked Google access to reauthentication guidance', async () => {
    const failing = new FakeGateway([]);
    failing.getMessage = async () => { throw Object.assign(new Error('revoked'), { code: 401 }); };
    const provider = async (alias: string) => ({ account: await config.get(alias), gateway: failing });
    service = new GmailService(config, undefined, provider);
    const error: unknown = await service.getMessage('work:w1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SwitchboardError);
    if (!(error instanceof SwitchboardError)) throw new Error('Expected SwitchboardError.');
    expect(error.code).toBe('AUTH_REQUIRED');
    expect(error.recovery).toContain('./setup --reauth');
  });

  it('maps insufficient Gmail scope errors to reauthentication guidance', async () => {
    const failing = new FakeGateway([]);
    failing.getMessage = async () => {
      throw Object.assign(new Error('insufficient permissions'), {
        response: {
          status: 403,
          data: { error: { errors: [{ reason: 'insufficientPermissions' }] } },
        },
      });
    };
    const provider = async (alias: string) => ({ account: await config.get(alias), gateway: failing });
    service = new GmailService(config, undefined, provider);

    await expect(service.getMessage('work:w1')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('turns malformed Gmail messages into structured API errors', async () => {
    work = new FakeGateway([{
      id: 'malformed',
      internalDate: String(Date.now()),
      payload: { headers: [] },
    }], 2, 'jacob@embrasure.ai');
    const provider = async (alias: string) => ({ account: await config.get(alias), gateway: work });
    service = new GmailService(config, undefined, provider);

    await expect(service.search({ accounts: ['work'] })).rejects.toBeInstanceOf(SwitchboardError);
  });
});
