import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, assertSafeServer } from './mcp/server.js';
import { safeDiagnostic } from './security/redact.js';

async function main(): Promise<void> {
  assertSafeServer();
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(`gmail-switchboard failed: ${safeDiagnostic(error)}\n`);
  process.exitCode = 1;
});
