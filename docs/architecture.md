# Architecture

Mailroom has one TypeScript MCP server and two thin plugin manifests. The Gmail façade delegates to focused search/pagination, read/attachment, mutation, and draft/compose services so account routing stays centralized without one oversized service class.

## Runtime

- The server uses the stable MCP TypeScript SDK over stdio.
- Codex, Claude Code, and Cursor all launch the same bundled `dist/server.js`.
- Codex loads `.codex-plugin/plugin.json` from the local marketplace.
- Claude Code loads `.claude-plugin/plugin.json` from its local marketplace.
- Cursor loads the server from its global `~/.cursor/mcp.json` configuration.
- `.mcp.json` resolves the plugin root at runtime for both clients.

The setup command builds before installing. Generated output is not committed.

## Accounts and credentials

Non-secret account metadata lives in a mode `0600` config file under the user's application-support directory. New installs use the bundled Mailroom Desktop OAuth client. A self-hosted client and every refresh token live in macOS Keychain under the `mailroom` service.

OAuth clients and account tokens are keyed by a client fingerprint. A switch authorizes every account against the target app before changing the active selection, so a failed sign-in leaves the old setup working.

Mailroom moves config and Keychain entries from the old `gmail-switchboard` names the first time it runs after an upgrade.

Each account has a short alias, and there is no fixed account limit. IDs cross the MCP boundary as `<alias>:<gmail-id>`. Raw Gmail IDs are rejected because the same-looking ID cannot safely identify an account.

## Search and pagination

Search defaults to every configured account. Each account is queried with bounded concurrency, message metadata is merged by date, and results retain their alias and email address.

Pagination state stays in the MCP process for 15 minutes after its last use. Cursors are random opaque UUIDs. The state includes per-account Gmail page tokens and buffered results, which prevents merged pagination from dropping messages. Cursors intentionally expire when the MCP process restarts.

An expired or unknown cursor returns `CURSOR_EXPIRED`, never an empty page. Agent guidance tells the client to repeat the original search without the cursor so partial results are not presented as complete.

Each search call also has a 45-second deadline and a bounded Gmail page budget. If either limit is reached, the response is marked `partial: true` and retains `next_cursor`, so the caller can continue without hanging or silently claiming completeness.

## Message handling

The server prefers `text/plain` MIME parts and converts HTML locally when plain text is unavailable. Conversion drops images and link targets. Parsed message bodies and thread responses are capped and report truncation. The explicit `include_raw_mime` option returns the full original MIME once, without a second base64 copy.

Attachments require a separate tool call. Executable and archive formats are blocked, the default limit is 1 MiB, and the hard limit is 25 MiB. Returned bytes include a SHA-256 digest and are never executed.

## Writes

The MCP mirrors the normal Gmail connector: labels, drafts, sends, forwards, archive, and Trash. New mail requires an account alias. Existing mail and drafts use qualified IDs, so the account is never guessed.

Outgoing Markdown is rendered locally into sanitized HTML with a plain-text part. Sends and draft creation are not retried because a retry could duplicate mail. Forwarding preserves original attachments but enforces a 25 MiB aggregate limit and never executes them. Delete moves mail to Gmail Trash. There is no permanent-delete API.
