# Public release

Public releases use a personal Google OAuth project per user. Do not advertise or select Mailroom's legacy shared OAuth client for new installs.

## Before changing visibility

- [x] Finish configuring `mailroom.jacobkieser.me`: verify the parent domain in GitHub, set the Pages custom domain, add the Namecheap CNAME, and enable HTTPS.
- [x] Update every public URL and confirm `MAILROOM_REQUIRE_OWNED_DOMAIN=1 pnpm validate:site` passes.
- [x] Make personal Google OAuth the guided default and keep the downloaded client and refresh tokens in Keychain.
- [x] Run `pnpm release:check` with the dedicated `personal` and `work` test accounts. This sends marked mail between them and moves it to Trash.
- Test the README install prompt from a clean directory in current Codex and Claude Code.
- Confirm `./setup --doctor` is healthy after restarting each client.
- [x] Confirm `./setup --doctor` is healthy with both clients installed and both Gmail test accounts connected.
- [x] Review the public Git history with `pnpm scan:history`.

## GitHub settings

- [x] Add the description: `Local multi-account Gmail MCP for Codex and Claude Code.`
- [x] Add topics: `gmail`, `mcp`, `codex`, `claude-code`, `macos`.
- [x] Enable dependency alerts and security updates.
- [x] Enable automatic deletion of merged branches.
- [x] Disable unused Projects and Wiki.
- [ ] After the repository is public, enable private vulnerability reporting, secret scanning, and push protection. These are unavailable on the current private-repository plan.
- [x] Protect `main`; require the Ubuntu Node 22/24/26 and macOS Node 24 CI checks, require linear history, and disallow force pushes and branch deletion.

## First release

- Tag the tested version from `main`.
- Publish matching release notes with setup, upgrade, and uninstall commands.
- Re-test the public README and policy links without a signed-in GitHub session.
- Test the personal Google setup guide from a clean Google Cloud project.
