# Mailroom

I use a few Gmail accounts and Codex only lets me connect one. So I made this.

It does the same stuff as the normal Gmail connector across however many accounts you want. Search, read, draft, send, forward, label, archive, and Trash.

Paste this into Codex:

```text
Install or safely update Mailroom from https://github.com/JacbK/mailroom in ~/.mailroom. Ask which Gmail accounts I want to add. Use the shared Google app, install it in Codex and/or Claude Code, and keep going until ~/.mailroom/setup --doctor is healthy. I'll handle Google sign-ins.
```

Start a new task when setup finishes.

Want your own Google app instead?

```sh
git clone https://github.com/JacbK/mailroom.git ~/.mailroom
~/.mailroom/setup --self-host ~/Downloads/google-oauth.json
```

[Self-hosting details](docs/self-hosting.md)
