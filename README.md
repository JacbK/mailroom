# Gmail Switchboard

Codex connects one Gmail. I use more. This fixes that.

One local, read-only MCP for as many accounts as you want, without mixing inboxes.

## Install it

Paste this into Codex:

```text
Install Gmail Switchboard from https://github.com/JacbK/gmail-switchboard. Ask for Gmail addresses and aliases, clone it, then run ./setup with repeated --account alias=email flags. Stop only for Google sign-in. Finish when ./setup --doctor is healthy in Codex and Claude.
```

Then start a new task.

Read-only. Credentials stay in macOS Keychain. Troubleshoot with `./setup --doctor`.
