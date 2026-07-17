# Security

Gmail Switchboard is intentionally local and read-only.

## Boundaries

- OAuth scope: `https://www.googleapis.com/auth/gmail.readonly`
- Credential store: macOS Keychain
- Transport: local stdio
- Gmail mutations: none
- Telemetry: none
- Remote HTML resources: never loaded
- Agent data path: requested Gmail results are returned to Codex or Claude and may be processed by that provider

Google classifies `gmail.readonly` as a restricted scope because it can read message bodies. OAuth credentials, refresh tokens, configuration, MIME conversion, and the MCP transport stay local. Email content does not necessarily stay on the machine: anything a tool returns is sent to the active Codex or Claude client and may be processed under that provider's data terms and controls. Making this a hosted or publicly distributed app would require a separate Google policy and verification review.

## Threat model

| Risk | Mitigation |
| --- | --- |
| OAuth token theft | Refresh tokens and the OAuth client are stored in Keychain, never plaintext config. Diagnostics never serialize credential objects. |
| Plaintext leakage | Account config contains aliases and addresses only. Secret scanning blocks common token formats and credential filenames. |
| Agent-provider exposure | Tools fetch only what the user or agent requests, cap and truncate results, and never include OAuth credentials. Users should choose Codex and Claude data controls appropriate for their mail. |
| Email prompt injection | MCP and skill instructions define email as untrusted data. The server exposes data but never interprets or executes email instructions. |
| Malicious HTML and tracking | HTML is converted locally. Images are skipped and link targets are removed. No remote resource is fetched. |
| Unsafe attachments | Attachments are explicit, size-capped, type-checked, hashed, and never executed. Executables and archives are blocked. |
| Excessive Google permissions | Only `gmail.readonly` is requested. There are no write tools. |
| Sensitive logs | Stdout is reserved for MCP. Errors are reduced to redacted names and messages. Email bodies and OAuth responses are never logged. |
| Dependency compromise | Exact dependency versions, a lockfile, frozen installs, peer checks, audit checks, and CI reduce drift. |
| Cross-account confusion | Every message and thread ID is account-qualified. Raw IDs are rejected. Every result repeats alias and address. |
| Installer tampering | Marketplaces point inside the repository, manifests are validated, builds are reproducible, and setup never evaluates downloaded scripts. |

## Removal

`./setup --uninstall` removes both plugins and offers to revoke Google access and delete Keychain credentials. Individual accounts can be removed with `./gmail-switchboard auth remove <alias>`.
