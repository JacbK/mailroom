# Google verification

Release gate for the shared Mailroom Google app.

## Console

- Project: `gmail-switchboard`
- App: `Mailroom by Jacob Kieser`
- Audience: External, In production
- Scope: `https://www.googleapis.com/auth/gmail.modify`
- Homepage: `https://jacbk.github.io/mailroom/`
- Privacy: `https://jacbk.github.io/mailroom/privacy.html`
- Terms: `https://jacbk.github.io/mailroom/terms.html`

## Before submission

1. Verify `https://jacbk.github.io/mailroom/` in Google Search Console with the meta tag already present on the homepage.
2. Request branding re-verification and confirm the ownership issue is gone.
3. Keep the Desktop client used by `shared-client.ts`, rename it `Mailroom Desktop`, and delete the unused Desktop client.
4. Run `pnpm release:check` locally.
5. Record one unlisted YouTube demo in English showing:
   - the complete Google consent flow and Mailroom client ID;
   - connecting both Gmail accounts;
   - search, read, attachment, labels, drafts, send, forward, archive, and Trash;
   - `./setup --doctor`, macOS Keychain storage, and uninstall/revoke.
6. Add the video URL to Data Access and submit the app from Verification Center.

Do not make the repository public or advertise shared OAuth until Google approves the restricted scope and the required security assessment is complete.
