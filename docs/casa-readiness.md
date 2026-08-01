# CASA AL1 readiness

Archived evidence packet for the legacy shared OAuth app. Personal-use OAuth is now the supported launch path; revive this packet only if shared OAuth returns.

## Assessment facts

- Google assigned AL1 with a due date of October 28, 2026.
- Google, not the developer, determines the assurance level.
- The July 30 reviewer thread asks Google to confirm eligibility for the no-cost AL1 path before a lab is selected or paid.
- The legacy CASA Tier 2 self-scan instructions are deprecated and are useful only as preparation.
- CASA 2.1.1 says it applies to web applications and web-accessible APIs. Mailroom is a local macOS desktop MCP process with no hosted application backend, database, admin UI, cookies, or application passwords. Google or its assigned lab must confirm the applicable profile and the not-applicable controls.

References:

- [Google security assessment requirements](https://support.google.com/cloud/answer/13465431)
- [Current CASA requirements](https://appdefensealliance.dev/casa/casa-requirements)
- [CASA assurance levels](https://appdefensealliance.dev/casa/casa-tiering)
- [CASA 2.1.1 specification](https://github.com/appdefensealliance/ASA-WG/blob/main/CASA/CASA%20Specification.md)

## Architecture summary

Mailroom is an open-source local Gmail connector for Codex and Claude Code. It uses Google's installed-app authorization-code flow with PKCE and a loopback redirect. Gmail API traffic goes directly from the user's Mac to Google over HTTPS. Refresh tokens and the OAuth desktop client are stored in macOS Keychain. Mailroom has no hosted backend, application database, telemetry, analytics, or advertising.

The only Google user-data recipients are Google, the user-selected MCP or AI client needed to perform the requested feature, and recipients the user explicitly selects for sent or forwarded email. Users must configure the selected AI account and workspace not to use submitted Gmail content to train generalized models.

## Control evidence

| CASA area | Mailroom evidence |
| --- | --- |
| Authentication | Google OAuth authenticates the user. Mailroom verifies the exact signed-in Gmail address before saving a token. It has no application passwords. |
| Sessions | Removing an account or uninstalling can revoke the Google refresh token. There are no Mailroom cookies or hosted sessions. |
| Access control | `gmail.modify` is the only Google scope. IDs are account-qualified, raw IDs are rejected, and writes require explicit user intent. Permanent delete is not implemented. |
| OAuth | Authorization code with PKCE, cryptographically random state, a loopback redirect, and exact state validation are implemented. |
| Communications | Gmail API and OAuth traffic use Google's official HTTPS endpoints and SDK. MCP traffic is local stdio. |
| Input handling | MCP inputs are schema-validated. HTML is converted locally without loading remote resources. Mailroom does not evaluate email content or fetch email-supplied URLs. |
| Files | Attachments are explicit, size-capped, type-checked, hashed, and never executed. |
| Secrets and logging | Tokens remain in Keychain and are never returned to the client. Errors are redacted; email bodies and OAuth responses are not logged. |
| Dependencies | Exact versions and a lockfile are used. CI runs frozen installs, audits, tests, and secret scans. |
| Domain | `mailroom.jacobkieser.me` is an active HTTPS GitHub Pages site on the verified `jacobkieser.me` domain. |

## Reproducible evidence

Run these commands from the repository root and retain the dated output for the assessor:

```sh
pnpm verify
pnpm test:coverage
pnpm audit --audit-level high
osv-scanner scan source --lockfile pnpm-lock.yaml
```

Also retain:

- the full-motion OAuth demonstration video;
- screenshots of the expanded consent screen and exact Cloud Console scope;
- the live homepage, privacy policy, and terms;
- a redacted Keychain screenshot showing credential storage;
- source references for PKCE/state validation, account-qualified IDs, redaction, attachment handling, and token revocation;
- CI results for the commit being assessed.

Never include real tokens, OAuth client files, email content, attachment data, or user cookies in evidence.

## Questions for Google or the assigned lab

1. Is project `gmail-switchboard` eligible for Google's no-cost AL1 route?
2. Which current CASA profile applies to a local installed desktop MCP process with no web backend?
3. Which web-only controls should be marked not applicable?
4. Should evidence wait until Trust & Safety formally initiates the assessment?
5. Is a developer-run scan accepted, required only for readiness, or replaced by lab testing for this assignment?

Do not pay a lab or submit deprecated Tier 2 artifacts until these points are confirmed in writing.
