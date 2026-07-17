# Gmail Switchboard Agent Guide

Keep the Gmail connector-parity surface working across any number of accounts. Mutations require explicit user intent, every ID stays account-qualified, and delete means recoverable Gmail Trash, never permanent deletion.

Run `pnpm verify` for code changes. Run `pnpm test:coverage` for behavior changes and `pnpm audit --audit-level high` before release work.

Never add real tokens, OAuth client files, email contents, attachment data, or user cookies to source, fixtures, snapshots, logs, or commits. Preserve account-qualified IDs across every boundary.
