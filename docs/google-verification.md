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

- Google replied on July 23 with two blocking requirements: move the public URLs to a developer-owned domain and replace the incomplete demo video.
- `mailroom.jacobkieser.me` is live on GitHub Pages with HTTPS. The homepage, privacy policy, terms, canonical URLs, and plugin manifest use the owned domain.
- Google Auth Platform now uses the owned homepage, privacy, and terms URLs. `jacobkieser.me` is the only authorized domain and Google Search Console confirms DNS ownership.
- The project remains External and In production. `gmail.modify` is the only requested scope, and `Mailroom Desktop` is the only OAuth client.
- The full release check passed on July 23, including all 22 live Gmail tools across the dedicated `personal` and `work` accounts. Its marked messages were moved to recoverable Gmail Trash.
- A replacement 2:50 reviewer demo has been rendered from the live configuration and test evidence. It still needs to be uploaded as an unlisted YouTube video before the reviewer reply is sent.

## Before approval

1. [x] Verify `jacobkieser.me` for the `JacbK` GitHub account, then configure `mailroom.jacobkieser.me` as the repository's GitHub Pages custom domain.
2. [x] Add a Namecheap BasicDNS CNAME with host `mailroom` and value `jacbk.github.io`, then enable HTTPS after GitHub provisions the certificate.
3. [x] Confirm every homepage, privacy, terms, canonical, and plugin-manifest URL uses `mailroom.jacobkieser.me`.
4. [x] Update Branding in Google Cloud Console and verify the owned domain in Search Console with DNS.
5. [x] Keep the Desktop client used by `shared-client.ts`, rename it `Mailroom Desktop`, and delete the unused Desktop client.
6. Upload the rendered replacement as one unlisted YouTube demo in English showing:
   - the complete Google consent flow with “Show all services” expanded and `gmail.modify` readable;
   - the exact same scope in Mailroom and Cloud Console;
   - connecting both Gmail accounts;
   - search, read, attachment, labels, draft create/update/list/send, direct send, forward, archive, and Trash;
   - each write reflected in the source Gmail account;
   - `./setup --doctor`, macOS Keychain storage, and uninstall/revoke.
7. Add the new video URL to Data Access and reply directly to the July 23 reviewer thread with confirmation of the domain move, URL updates, domain verification, and replacement video.
8. Complete the required CASA security assessment.

Do not make the repository public or advertise shared OAuth until Google approves the restricted scope and the required security assessment is complete.
