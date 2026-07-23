# Mailroom

I use a few Gmail accounts and Codex only lets me connect one. So I made this.

It has the same Gmail plugin functionality across as many accounts as you want: search, read, draft, send, forward, label, archive, and Trash.

Paste this into Codex:

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
