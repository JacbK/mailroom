# Gmail Switchboard

Codex only lets me hook up one Gmail. I use two. This fixes that.

It gives Codex and Claude one read-only Gmail MCP across:

- `work` → `jacob@embrasure.ai`
- `personal` → `jacobk2112@gmail.com`

It searches both by default and keeps every message tied to the right account.

## Install it

Paste this into Codex:

```text
Install my private Gmail Switchboard plugin from https://github.com/JacbK/gmail-switchboard. Clone it to ~/Documents/Development/gmail-switchboard if needed, run ./setup, and keep going until Codex and Claude both show the MCP as connected and ./setup --doctor says work (jacob@embrasure.ai) and personal (jacobk2112@gmail.com) are healthy. Pause only when Google needs me to sign in or approve access.
```

That is it. Start a new thread when setup finishes.

Try:

```text
Find the latest GitHub email across both accounts.
Search only my work Gmail for AWS.
Find personal receipts from the last month.
Show me which inbox each result came from.
```

It can search and read mail, threads, and requested attachments. It cannot send or change anything. Credentials stay in macOS Keychain.

If something is off, run `./setup --doctor`. For more detail, see [security](docs/security.md) and [development](docs/development.md).
