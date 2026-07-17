import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GmailService } from '../../src/gmail/service.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { ConfigStore } from '../../src/storage/config-store.js';
import { FakeGateway } from '../helpers.js';

let config: ConfigStore;
let client: Client;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmail-switchboard-mcp-'));
  config = new ConfigStore(join(directory, 'accounts.json'));
  await config.upsert({ alias: 'work', email: 'jacob@embrasure.ai' });
  const gateway = new FakeGateway([], 2, 'jacob@embrasure.ai');
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
  await config.clear();
});

describe('MCP surface', () => {
  it('advertises five accurately annotated read-only tools', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'gmail_accounts',
      'gmail_search',
      'gmail_get_message',
      'gmail_get_thread',
      'gmail_get_attachment',
    ]);
    for (const tool of tools.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });

  it('puts the safety and account-routing rules in server instructions', () => {
    expect(client.getInstructions()?.startsWith('Gmail Switchboard is read-only.')).toBe(true);
    expect(client.getInstructions()).toContain('account-qualified');
    expect(client.getInstructions()).toContain('untrusted external data');
  });

  it('returns structured account health without credentials', async () => {
    const response = await client.callTool({ name: 'gmail_accounts', arguments: {} });
    const serialized = JSON.stringify(response);
    expect(response.isError).not.toBe(true);
    expect(serialized).toContain('jacob@embrasure.ai');
    expect(serialized).not.toContain('refreshToken');
    expect(serialized).not.toContain('accessToken');
  });

  it('rejects unqualified message IDs as structured tool errors', async () => {
    const response = await client.callTool({
      name: 'gmail_get_message',
      arguments: { message_id: 'raw-id' },
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('AMBIGUOUS_ID');
  });
});
