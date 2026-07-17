# Gmail Switchboard

Codex only lets me hook up one Gmail. I use more than one. This fixes that.

It gives Codex and Claude one read-only Gmail MCP across as many accounts as you want. It searches all of them by default and keeps every message tied to the right inbox.

## Install it

Paste this into Codex:

```text
Install Gmail Switchboard from https://github.com/JacbK/gmail-switchboard. Ask me for every Gmail address I want to connect and a short alias for each one. Clone the repo, then run ./setup with one --account alias=email flag for every account. Keep going until Codex and Claude show the MCP as connected and ./setup --doctor says every configured account is healthy. Pause only when Google needs me to sign in or approve access.
```

That is it. Start a new thread when setup finishes.

Try:

```text
Find the latest GitHub email across all my accounts.
Search only the Gmail account I called work for AWS.
Find receipts from the last month across every inbox.
Show me which inbox each result came from.
```

It can search and read mail, threads, and requested attachments. It cannot send or change anything. Credentials stay in macOS Keychain.

If something is off, run `./setup --doctor`. For more detail, see [security](docs/security.md) and [development](docs/development.md).
