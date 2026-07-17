# Claude review record

Claude Opus reviewed this project three times on July 17, 2026. Claude only reviewed and did not modify, commit, push, publish, or access Gmail.

## Integration review

- Rejected the claimed Codex path-resolution bug. A fresh Codex session launched the plugin from `/tmp`, called `gmail_accounts`, and returned the connected account. Codex did not depend on the caller's working directory.
- Rejected adding `mcpServers` to the Claude manifest. Claude's strict validator accepts the manifest, and `claude mcp list` reports the plugin-root `.mcp.json` server as connected. Adding an unsupported manifest field would be less correct.
- Accepted the Node-version drift finding. CI now tests Node 22 and 24.
- Accepted the cursor-recovery finding. Expiry is a structured error and the skill tells agents to repeat the original search.
- Rejected making dependency audit non-blocking. A high-severity dependency audit is an explicit project completion gate.
- Rejected the README fence finding. The source uses normal backtick fences; the review bundle escaped them.

## Security and pagination review

Accepted and fixed every concrete finding:

- Transient Gmail failures now report `error`, not `needs_auth`.
- Duplicate-only Gmail pages have a per-call fetch budget.
- Searches have an aggregate deadline and explicit partial-page metadata with a continuation cursor.
- Cursor eviction uses last-use recency.
- Gmail 403 scope failures map to reauthentication guidance.
- Concurrent use of one cursor is rejected instead of corrupting state.
- Partial pages stop before global chronological order becomes uncertain.
- Agent guidance distinguishes transient errors from broken authentication.

The final focused review confirmed the earlier five findings were fixed and found the last three items above, which were also fixed and covered by tests.
