# Claude review record

Claude Opus reviewed this project five times on July 17, 2026. Claude only reviewed and did not modify, commit, push, publish, or access Gmail.

## Connector parity review

Claude Opus reviewed the 0.2 write-capability expansion in an isolated worktree.

- Forwarding now enforces a 25 MiB aggregate attachment limit before downloading. It still preserves original attachments for Gmail parity.
- Raw MIME no longer returns a duplicate base64 copy. The full-MIME exception is documented.
- Old read-only credentials now get a clear one-time permission-upgrade message.
- User-label IDs must be account-qualified and searches only query the owning accounts.
- Cross-account label, archive, and Trash actions return partial success details instead of hiding earlier changes.
- A direct contract test confirms per-account label filters reach Gmail.

## Unlimited-account onboarding follow-up

- Setup no longer reauthenticates an unrelated account after a transient error.
- Account flag parsing, duplicate detection, and configured-account collisions now have direct tests.
- Non-interactive setup errors earlier, and malformed email addresses are rejected before OAuth.
- The suggested static MCP account cap was rejected because configured aliases already bound execution and the plugin intentionally supports any number of accounts.

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

## OAuth import follow-up

Claude Opus reviewed the Keychain import and source-deletion boundary after it was added. Its focused bundle omitted the implementation files, so Codex checked each finding against the source instead of treating the review as authoritative.

- Confirmed the Keychain helper's non-zero exit prevents source deletion.
- Confirmed deletion runs only after the awaited Keychain write.
- Confirmed deletion failure already exits with `CREDENTIAL_FILE_CLEANUP_FAILED`; the recovery message now includes the exact source path.
- Added tests proving a failed Keychain write preserves the JSON and a failed cleanup reports the path after storing the credential.
- Added the plaintext retention warning to the README and security guide.
- Rejected scanning Downloads in `doctor`; searching unrelated user files would add a privacy cost without improving credential correctness.
