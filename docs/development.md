# Development

Requirements: macOS, Node 22 or newer, pnpm 11, Codex, and Claude Code.

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm test:coverage
pnpm audit --audit-level high
```

The official Codex plugin-creator validator runs when it is installed. Claude's strict plugin validator runs when the Claude CLI is installed. CI always runs structural validation too.

Useful source areas:

- `src/auth`: OAuth and exact identity verification
- `src/security`: Keychain and diagnostic redaction
- `src/gmail`: account routing, Gmail API calls, MIME parsing, and pagination
- `src/mcp`: tool schemas, annotations, and server instructions
- `test/unit`: pure behavior tests
- `test/contract`: mocked Gmail and in-memory MCP tests

Do not add Gmail write scopes or mutation tools as part of an unrelated change. Do not put real email bodies, headers, OAuth responses, or attachment data into fixtures.

Current reference docs:

- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [MCP TypeScript SDK v1](https://ts.sdk.modelcontextprotocol.io/server)
- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
