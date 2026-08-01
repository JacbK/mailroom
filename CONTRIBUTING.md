# Contributing

Mailroom is deliberately narrow: local macOS setup, multiple Gmail accounts, and connector-parity tools for Codex and Claude Code. Bug fixes are welcome. Please discuss new scopes, clients, or large features before building them.

## Before a pull request

1. Read [the architecture](docs/architecture.md) and [security model](docs/security.md).
2. Run `pnpm install --frozen-lockfile`.
3. Run `pnpm verify`.
4. For behavior changes, also run `pnpm test:coverage`.

Keep these invariants:

- Gmail mutations require explicit user intent.
- Every message, thread, draft, and user-label ID remains account-qualified.
- Delete means recoverable Gmail Trash, never permanent deletion.
- Tokens, OAuth JSON, email contents, attachment data, and user cookies never enter source, fixtures, logs, screenshots, or commits.
- Generated `dist` and `coverage` output stays uncommitted.

Use synthetic addresses and message content in tests. For shareable diagnostics, run `~/.mailroom/mailroom doctor --redact`.
