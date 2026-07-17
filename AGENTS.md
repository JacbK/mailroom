# Gmail Switchboard Agent Guide

Keep this project read-only. Do not add Gmail mutations or broader OAuth scopes unless the user explicitly requests a separately reviewed capability.

Run `pnpm verify` for code changes. Run `pnpm test:coverage` for behavior changes and `pnpm audit --audit-level high` before release work.

Never add real tokens, OAuth client files, email contents, attachment data, or user cookies to source, fixtures, snapshots, logs, or commits. Preserve account-qualified IDs across every boundary.
