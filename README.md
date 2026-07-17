# Gmail Switchboard

Codex only lets me hook up one Gmail. I use two. This fixes that.

It gives Codex and Claude Code one read-only inbox tool with clear account names:

- `work` is `jacob@embrasure.ai`
- `personal` is `jacobk2112@gmail.com`

Searches use both by default. Every message and thread ID keeps its account name, so an agent cannot accidentally open a personal thread through the work account.

## Set it up

Clone the private repo, then run:

```sh
./setup
```

That installs the Codex and Claude Code plugins, opens Google sign-in twice, verifies both email addresses, and runs the health checks.

Google has one unavoidable setup step. You need a Google Cloud **Desktop app** OAuth client with the Gmail API enabled. If the consent screen is in testing, add both email addresses as test users. `./setup` opens the right page and asks for the downloaded JSON. It stores the OAuth client in macOS Keychain, deletes the downloaded JSON after a successful import, and never puts credentials in this repo.

Then start a fresh thread and ask things like:

```text
Find the latest email from GitHub across both of my accounts.
Search only my work Gmail for the latest AWS email.
Search my personal Gmail for receipts from the last month.
Show me which inbox each result came from.
```

## Useful commands

```sh
./setup --doctor
./setup --reauth
./gmail-switchboard auth list
./gmail-switchboard auth add another-account another@example.com
./gmail-switchboard auth remove another-account
./setup --uninstall
```

`auth add` works for more than two accounts. Aliases are short names agents can use in searches.

## What it can do

- Search one Gmail or all of them together
- Read a message or its full thread
- Fetch a requested safe attachment with size limits
- Keep work and personal IDs separate

It cannot send, reply, draft, delete, archive, label, or change anything in Gmail. Email text is treated as untrusted data, not agent instructions. Remote images and tracking links are never loaded.

Credentials stay in your Mac's Keychain. Email results you ask to read are passed to Codex or Claude so the agent can answer, which means that content may be processed under that provider's data terms and settings.

## If something is off

Run `./setup --doctor` first. If an account says `needs_auth`, run `./setup --reauth`. If Google selected the wrong account, nothing is saved. Retry and choose the exact address shown by setup.

The deeper details are in [the architecture](docs/architecture.md), [security notes](docs/security.md), and [development guide](docs/development.md).
