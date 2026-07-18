# Security

Mailroom is local. It can read and change Gmail only through explicit MCP tool calls.

## Boundaries

- OAuth scope: `https://www.googleapis.com/auth/gmail.modify`
- OAuth apps: verified Mailroom Desktop client by default, or a user-provided Desktop client
- Credential store: macOS Keychain
- Transport: local stdio
- Gmail mutations: drafts, sends, forwards, labels, archive, and recoverable Trash
- Telemetry: none
- Remote HTML resources: never loaded
- Agent data path: requested Gmail results are returned to Codex or Claude and may be processed by that provider

Google classifies `gmail.modify` as a restricted scope. It allows the connector-parity features without permanent deletion. OAuth credentials, refresh tokens, configuration, MIME conversion, and the MCP transport stay local. Anything a tool returns is sent to the active Codex or Claude client and may be processed under that provider's data terms and controls. A hosted or publicly distributed app needs a separate Google policy and verification review.

## Threat model

| Risk | Mitigation |
| --- | --- |
| OAuth token theft | Refresh tokens and the OAuth client are stored in Keychain, never plaintext config. Diagnostics never serialize credential objects. |
| Plaintext leakage | Account config contains aliases and addresses only. Setup deletes the downloaded OAuth JSON after a successful Keychain import. A failed Keychain write preserves the source file; a failed deletion exits with the exact path to remove manually. Secret scanning blocks common token formats and credential filenames. |
| Agent-provider exposure | Tools fetch only what the user or agent requests, cap parsed results, and never include OAuth credentials. The explicit raw-MIME option returns the full source message. Users should choose Codex and Claude data controls appropriate for their mail. |
| Email prompt injection | MCP and skill instructions define email as untrusted data. Mutations require the user's explicit request, never instructions found inside mail. |
| Malicious HTML and tracking | HTML is converted locally. Images are skipped and link targets are removed. No remote resource is fetched. |
| Unsafe attachments | Attachments returned to the agent are explicit, size-capped, type-checked, hashed, and never executed. For parity, forwarding preserves original attachments under a 25 MiB aggregate cap without executing them. |
| Excessive Google permissions | Only `gmail.modify` is requested. The plugin has no permanent-delete tool and uses Gmail Trash. |
| Wrong-account writes | Every message, thread, draft, and user-label ID is account-qualified. New drafts and sends require an explicit account alias. |
| Duplicate sends | Send and draft-create API calls are not automatically retried. |
| Sensitive logs | Stdout is reserved for MCP. Errors are reduced to redacted names and messages. Email bodies and OAuth responses are never logged. |
| Dependency compromise | Exact dependency versions, a lockfile, frozen installs, peer checks, audit checks, and CI reduce drift. |
| Cross-account confusion | Every message and thread ID is account-qualified. Raw IDs are rejected. Every result repeats alias and address. |
| Installer tampering | Marketplaces point inside the repository, manifests are validated, builds are reproducible, and setup never evaluates downloaded scripts. |

## Removal

`./setup --uninstall` removes the Codex and Claude plugins and offers to revoke Google access and delete every Keychain credential. Individual accounts can be removed with `./mailroom auth remove <alias>`.

The bundled Desktop client identifies Mailroom but cannot grant account access. Refresh tokens stay in Keychain. In self-hosted mode, the downloaded Google OAuth JSON exists in plaintext only until setup moves it into Keychain and deletes the source file.

Google treats Desktop client secrets as public application identifiers. Someone can copy Mailroom's client ID and secret, but PKCE prevents intercepted authorization codes from being reused and Mailroom verifies the exact signed-in address before saving a token. Google consent still identifies the requesting client, so users should install Mailroom only from this repository.
