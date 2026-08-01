import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe('bundled stdio server', () => {
  it('starts as a real process and advertises the Mailroom tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(import.meta.dirname, '../../dist/server.js')],
      stderr: 'pipe',
    });
    client = new Client({ name: 'mailroom-stdio-test', version: '1.0.0' });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(22);
    expect(tools.tools.map((tool) => tool.name)).toContain('gmail_accounts');
    expect(tools.tools.map((tool) => tool.name)).toContain('gmail_send_email');
    expect(client.getInstructions()).toContain('account-qualified');
  });
});
