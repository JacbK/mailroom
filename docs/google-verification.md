# Google verification

Release gate for the shared Mailroom Google app.

## Console

- Project: `gmail-switchboard`
- App: `Mailroom by Jacob Kieser`
- Audience: External, In production
- Scope: `https://www.googleapis.com/auth/gmail.modify`
- Target homepage: `https://mailroom.jacobkieser.me/`
- Target privacy: `https://mailroom.jacobkieser.me/privacy.html`
- Target terms: `https://mailroom.jacobkieser.me/terms.html`

## Current status

- Google replied on July 23 with two blocking requirements.
- Google will not accept the `github.io` homepage and privacy policy, even though Search Console verified the project URL and parent property.
- The chosen developer-owned domain is `mailroom.jacobkieser.me`. Its canonical URLs are prepared locally but are not live until the GitHub Pages and DNS steps below are complete.
- The demo video must be replaced with a complete walkthrough of every `gmail.modify` feature, the expanded consent screen, and the resulting changes in Gmail.

## Before approval

1. Verify `jacobkieser.me` for the `JacbK` GitHub account, then configure `mailroom.jacobkieser.me` as the repository's GitHub Pages custom domain.
2. Add a Namecheap BasicDNS CNAME with host `mailroom` and value `jacbk.github.io`, then enable HTTPS after GitHub provisions the certificate.
3. Confirm every homepage, privacy, terms, canonical, and plugin-manifest URL uses `mailroom.jacobkieser.me`.
4. Update Branding in Google Cloud Console and verify the owned domain in Search Console with DNS.
5. Keep the Desktop client used by `shared-client.ts`, rename it `Mailroom Desktop`, and delete the unused Desktop client.
6. Record one unlisted YouTube demo in English showing:
   - the complete Google consent flow with “Show all services” expanded and `gmail.modify` readable;
   - the exact same scope in Mailroom and Cloud Console;
   - connecting both Gmail accounts;
   - search, read, attachment, labels, draft create/update/list/send, direct send, forward, archive, and Trash;
   - each write reflected in the source Gmail account;
   - `./setup --doctor`, macOS Keychain storage, and uninstall/revoke.
7. Add the new video URL to Data Access and reply directly to the July 23 reviewer thread with confirmation of the domain move, URL updates, domain verification, and replacement video.
8. Complete the required CASA security assessment.

Do not make the repository public or advertise shared OAuth until Google approves the restricted scope and the required security assessment is complete.
