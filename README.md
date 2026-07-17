# Gmail Switchboard

I use a few Gmail accounts and Codex only lets me connect one. So I made this.

It gives Codex and Claude one read-only Gmail tool across however many accounts you want. It searches all of them by default and keeps track of which inbox each email came from.

## Set it up

Paste this into Codex:

```text
Install Gmail Switchboard from https://github.com/JacbK/gmail-switchboard for me. Ask me which Gmail accounts I want to add and what to call each one. Keep going until it works in Codex and Claude and ./setup --doctor is healthy. I'll handle the Google sign-ins.
```

That's it. Start a new task after setup.

It's read-only and keeps credentials in macOS Keychain. If something's weird, run `./setup --doctor`.
