# Why Mailroom uses personal OAuth

Google confirmed on July 31, 2026 that free self-scans are no longer available for new CASA submissions. A shared Mailroom app with full Gmail access would need a paid annual assessment.

## Options checked

| Option | CASA | What breaks |
| --- | --- | --- |
| Personal OAuth project per user | No verification required for personal use under 100 users | One-time Google Cloud setup and an expected unverified-app warning |
| Internal Google Workspace project | No public verification | Only accounts inside that Workspace organization can connect |
| Shared `gmail.send` app | No CASA; sensitive-scope verification still applies | No search, read, drafts, archive, message labels, or Trash |
| Shared `gmail.readonly` app | Still restricted | Writes disappear and CASA is still required |
| Shared metadata or compose app | Still restricted | Less functionality and CASA is still required |
| Gmail Add-on current-message scopes | No CASA for the narrow contextual scopes | Works only inside a running Gmail add-on, not as a multi-inbox MCP |
| IMAP/SMTP with OAuth | Still restricted | Google requires restricted-scope review |
| IMAP/SMTP with an app password | No OAuth review | Google discourages it; unavailable for some Workspace and Advanced Protection accounts; broad credential; major backend rewrite |
| Apple Mail automation | No Google API review | macOS-only, slower search, weaker Gmail label/thread semantics, and another Automation permission |

## Why this is the supported path

Mailroom needs `gmail.modify` for its actual product: search, read, drafts, sends, forwards, message labels, archive, and recoverable Trash. Google classifies `gmail.readonly`, `gmail.metadata`, `gmail.compose`, and `gmail.modify` as restricted. Switching to read-only would remove half the product without removing the assessment requirement.

Google exempts personal-use apps with fewer than 100 users from mandatory verification. Each Mailroom user owns one private project used by only their accounts, so there is no shared project cap or paid Mailroom assessment. Publishing that private project to **In production** prevents the seven-day refresh-token expiration that applies in Testing. It does not remove the expected unverified-app warning.

For a company, an **Internal** project is cleaner: it avoids the warning and user cap, but only accounts in that Workspace organization can authorize it.

## Could a local shared app avoid CASA?

Google's current restricted-scope guide says the security assessment applies when restricted data is stored or transmitted on servers. Mailroom has no backend, but its useful tool results are intentionally returned to a selected cloud AI client. Google reviewed this architecture and explicitly assigned AL1, so claiming a local-app exemption for the shared project is no longer defensible.

Apple Mail remains the only credible path that avoids both Google OAuth and Google Cloud setup. Its macOS 16 scripting interface exposes accounts, mailboxes, message content and source, attachments, read/flag/delete state, send, reply, forward, move, and IMAP synchronization. It is a possible future fallback, but it cannot currently match Gmail API behavior closely enough to replace personal OAuth.

## Sources

- [Google Gmail scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [When OAuth verification is not needed](https://support.google.com/cloud/answer/13464323)
- [Publishing status, user caps, and seven-day Testing tokens](https://support.google.com/cloud/answer/15549945)
- [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Google OAuth verification FAQ, including IMAP/SMTP](https://support.google.com/cloud/answer/13463817)
- [Google app-password limitations](https://support.google.com/mail/answer/185833)
