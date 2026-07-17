# Architecture

Gmail Switchboard has one TypeScript MCP server and two thin plugin manifests.

## Runtime

- The server uses the stable MCP TypeScript SDK over stdio.
- Codex and Claude Code both launch the same bundled `dist/server.js`.
- Codex loads `.codex-plugin/plugin.json` from the local marketplace.
- Claude Code loads `.claude-plugin/plugin.json` from its local marketplace.
- `.mcp.json` resolves the plugin root at runtime for both clients.

The setup command builds before installing. Generated output is not committed.

## Accounts and credentials

Non-secret account metadata lives in a mode `0600` config file under the user's application-support directory. The Google OAuth client and per-account refresh tokens live in macOS Keychain under the `gmail-switchboard` service.

Each account has a short alias, and there is no fixed account limit. IDs cross the MCP boundary as `<alias>:<gmail-id>`. Raw Gmail IDs are rejected because the same-looking ID cannot safely identify an account.

## Search and pagination

Search defaults to every configured account. Each account is queried with bounded concurrency, message metadata is merged by date, and results retain their alias and email address.

Pagination state stays in the MCP process for 15 minutes after its last use. Cursors are random opaque UUIDs. The state includes per-account Gmail page tokens and buffered results, which prevents merged pagination from dropping messages. Cursors intentionally expire when the MCP process restarts.

An expired or unknown cursor returns `CURSOR_EXPIRED`, never an empty page. Agent guidance tells the client to repeat the original search without the cursor so partial results are not presented as complete.

Each search call also has a 45-second deadline and a bounded Gmail page budget. If either limit is reached, the response is marked `partial: true` and retains `next_cursor`, so the caller can continue without hanging or silently claiming completeness.

## Message handling

The server prefers `text/plain` MIME parts and converts HTML locally when plain text is unavailable. Conversion drops images and link targets. Message bodies and thread responses are capped and report truncation.

Attachments require a separate tool call. Executable and archive formats are blocked, the default limit is 1 MiB, and the hard limit is 5 MiB. Returned bytes include a SHA-256 digest and are never executed.
