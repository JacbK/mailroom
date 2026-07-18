import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GmailService } from '../../src/gmail/service.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { ConfigStore } from '../../src/storage/config-store.js';
import { FakeGateway, message } from '../helpers.js';

let config: ConfigStore;
let client: Client;
let closeServer: () => Promise<void>;
let gateway: FakeGateway;

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mailroom-mcp-'));
  config = new ConfigStore(join(directory, 'accounts.json'));
  await config.upsert({ alias: 'work', email: 'work@example.com' });
  gateway = new FakeGateway([
    message({
      id: 'w1',
      threadId: 'wt',
      date: '2026-07-17T12:00:00Z',
      attachment: { id: 'a1', filename: 'note.txt', mimeType: 'text/plain', size: 5 },
    }),
  ], 2, 'work@example.com');
  gateway.attachments.set('a1', 'hello');
  const provider = async (alias: string) => ({ account: await config.get(alias), gateway });
  const server = createMcpServer(new GmailService(config, undefined, provider));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeServer = async () => await server.close();
});

afterEach(async () => {
  await client.close();
  await closeServer();
  await rm(dirname(config.path), { recursive: true, force: true });
});

describe('MCP surface', () => {
  it('advertises Gmail connector parity plus account health', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'gmail_accounts',
      'gmail_get_profile',
      'gmail_search_emails',
      'gmail_search_email_ids',
      'gmail_read_email',
      'gmail_batch_read_email',
      'gmail_read_email_thread',
      'gmail_batch_read_email_threads',
      'gmail_read_attachment',
      'gmail_list_labels',
      'gmail_create_label',
      'gmail_apply_labels_to_emails',
      'gmail_bulk_label_matching_emails',
      'gmail_archive_emails',
      'gmail_delete_emails',
      'gmail_batch_modify_email',
      'gmail_create_draft',
      'gmail_update_draft',
      'gmail_list_drafts',
      'gmail_send_draft',
      'gmail_send_email',
      'gmail_forward_emails',
    ]);
    expect(tools.tools.find((tool) => tool.name === 'gmail_read_email')?.annotations)
      .toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(tools.tools.find((tool) => tool.name === 'gmail_create_draft')?.annotations)
      .toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tools.tools.find((tool) => tool.name === 'gmail_send_email')?.annotations)
      .toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  });

  it('puts the safety and account-routing rules in server instructions', () => {
    expect(client.getInstructions()?.startsWith('Mailroom manages multiple Gmail accounts.')).toBe(true);
    expect(client.getInstructions()).toContain('account-qualified');
    expect(client.getInstructions()).toContain('untrusted external data');
    expect(client.getInstructions()).toContain('explicitly asks');
  });

  it('returns structured account health without credentials', async () => {
    const response = await client.callTool({ name: 'gmail_accounts', arguments: {} });
    const serialized = JSON.stringify(response);
    expect(response.isError).not.toBe(true);
    expect(serialized).toContain('work@example.com');
    expect(serialized).not.toContain('refreshToken');
    expect(serialized).not.toContain('accessToken');
  });

  it('rejects unqualified message IDs as structured tool errors', async () => {
    const response = await client.callTool({
      name: 'gmail_read_email',
      arguments: { message_id: 'raw-id' },
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('AMBIGUOUS_ID');
  });

  it('executes every Gmail parity tool through MCP', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [
      { name: 'gmail_get_profile', arguments: {} },
      { name: 'gmail_search_emails', arguments: { query: 'in:anywhere' } },
      { name: 'gmail_search_email_ids', arguments: { query: 'in:anywhere' } },
      { name: 'gmail_read_email', arguments: { message_id: 'work:w1', include_raw_mime: true } },
      { name: 'gmail_batch_read_email', arguments: { message_ids: ['work:w1'] } },
      { name: 'gmail_read_email_thread', arguments: { id: 'work:w1' } },
      { name: 'gmail_batch_read_email_threads', arguments: { ids: ['work:wt'], id_type: 'thread' } },
      { name: 'gmail_read_attachment', arguments: { message_id: 'work:w1', filename: 'note.txt' } },
      { name: 'gmail_list_labels', arguments: {} },
      { name: 'gmail_create_label', arguments: { account: 'work', name: 'Follow up' } },
      {
        name: 'gmail_apply_labels_to_emails',
        arguments: { message_ids: ['work:w1'], add_label_names: ['Follow up'] },
      },
      {
        name: 'gmail_bulk_label_matching_emails',
        arguments: { account: 'work', query: 'in:anywhere', label_name: 'Follow up' },
      },
      { name: 'gmail_archive_emails', arguments: { message_ids: ['work:w1'] } },
      {
        name: 'gmail_batch_modify_email',
        arguments: { message_ids: ['work:w1'], add_labels: ['STARRED'] },
      },
      {
        name: 'gmail_create_draft',
        arguments: { account: 'work', to: 'person@example.com', subject: 'Draft', body: 'Hello' },
      },
      {
        name: 'gmail_update_draft',
        arguments: { draft_id: 'work:draft-1', subject: 'Updated', body: 'Updated body' },
      },
      { name: 'gmail_list_drafts', arguments: { account: 'work' } },
      { name: 'gmail_send_draft', arguments: { draft_id: 'work:draft-1' } },
      {
        name: 'gmail_send_email',
        arguments: { account: 'work', to: 'person@example.com', subject: 'Sent', body: 'Hello' },
      },
      {
        name: 'gmail_forward_emails',
        arguments: { message_ids: ['work:w1'], to: 'person@example.com', note: 'FYI' },
      },
      { name: 'gmail_delete_emails', arguments: { message_ids: ['work:w1'] } },
    ];

    for (const call of calls) {
      const response = await client.callTool(call);
      expect(response.isError, `${call.name}: ${JSON.stringify(response)}`).not.toBe(true);
    }
  });
});
