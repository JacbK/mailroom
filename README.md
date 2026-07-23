# Mailroom

I use a few Gmail accounts and Codex only lets me connect one. So I made this.

Mailroom gives Codex and Claude Code the normal Gmail tools across as many accounts as you want: search, read, draft, send, forward, label, archive, and Trash. It runs locally on macOS, with tokens in Keychain.

Requires macOS, Node 22 or newer, and Codex or Claude Code.

Paste this into Codex or Claude Code:

```text
Install or safely update Mailroom from https://github.com/JacbK/mailroom in ~/.mailroom. Ask which Gmail accounts I want to add, then run ~/.mailroom/setup --shared with one --account alias=email flag for each account. Keep going until ~/.mailroom/setup --doctor is healthy. I'll handle Google sign-ins.
```

Start a new task when setup finishes.

The default setup uses the Mailroom Google app. Google may block new users until its restricted-scope verification is complete.

Want to use your own Google app instead?

```sh
git clone https://github.com/JacbK/mailroom.git ~/.mailroom
~/.mailroom/setup --self-host ~/Downloads/google-oauth.json
```

[Create your Google app](docs/self-hosting.md)

## Use it

Name the inbox you mean, or leave it out to search all of them:

```text
Search all my inboxes for the latest flight receipt.
Draft a reply from work to the latest message from Maya.
Archive these newsletters from personal.
```

Mailroom keeps every message, thread, draft, and label ID tied to its account. Sending, forwarding, labeling, archiving, and Trash still require an explicit request.

## Fix setup

```sh
~/.mailroom/setup --doctor
~/.mailroom/setup --reauth
~/.mailroom/setup --account another=you@example.com
```

If Google blocks the shared app, [use your own Google app](docs/self-hosting.md). To remove Mailroom, run `~/.mailroom/setup --uninstall`.

## Project

- [Security model](docs/security.md) and [private vulnerability reporting](SECURITY.md)
- [Privacy policy](https://mailroom.jacobkieser.me/privacy.html)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
- [MIT License](LICENSE)
