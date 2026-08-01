# Google verification

Historical record for the legacy shared Mailroom Google app.

## Console

- Project: `gmail-switchboard`
- App: `Mailroom by Jacob Kieser`
- Audience: External, In production
- Scope: `https://www.googleapis.com/auth/gmail.modify`
- Target homepage: `https://mailroom.jacobkieser.me/`
- Target privacy: `https://mailroom.jacobkieser.me/privacy.html`
- Target terms: `https://mailroom.jacobkieser.me/terms.html`

## Current status

- On July 31, Google confirmed that free self-scans are no longer available for new CASA submissions. Completing shared restricted-scope verification requires a paid authorized assessor, with Google's TAC Security discount still below $1,000.
- Mailroom is retiring shared OAuth for new installs. The launch path now uses one personal-use Google OAuth project per user, preserving `gmail.modify` without making users share Jacob's project or its 100-user cap.
- The alternatives and their policy tradeoffs are recorded in [Why Mailroom uses personal OAuth](oauth-options.md).
- The installer opens a guided setup page, watches Downloads for a valid Desktop OAuth JSON, imports it into Keychain, deletes the downloaded file, and continues sign-in. Existing shared connections receive migration guidance.
- Canceling the shared project's pending verification and removing its production OAuth client remain manual Cloud Console actions.

- Google replied again on July 24 because the first replacement video was not full-motion and the privacy policy did not describe data-protection mechanisms.
- Google replied on July 30 because the privacy policy did not explicitly identify every party that can receive Google user data.
- `mailroom.jacobkieser.me` is live on GitHub Pages with HTTPS. The homepage, privacy policy, terms, canonical URLs, and plugin manifest use the owned domain.
- The privacy policy now explicitly documents HTTPS transport, local-only processing, macOS Keychain protection, attachment safeguards, redacted errors, account-qualified identifiers, recoverable Trash, and retention/deletion behavior. It also identifies the only data recipients: Google, the user's selected MCP or AI client, and email recipients the user explicitly chooses.
- Google Auth Platform now uses the owned homepage, privacy, and terms URLs. `jacobkieser.me` is the only authorized domain and Google Search Console confirms DNS ownership.
- The project remains External and In production. `gmail.modify` is the only requested scope, and `Mailroom Desktop` is the only OAuth client.
- A fresh live release check passed on July 27, including all 22 Gmail tools across the dedicated `personal` and `work` accounts. Seven synthetic test messages were moved to recoverable Gmail Trash.
- The new 1:18 full-motion reviewer demo is published unlisted at `https://youtu.be/z7bMMxIFmKw`. It shows the expanded production consent details, live MCP operations, source Gmail effects, and the published data-protection policy.
- Google Data Access uses the new video URL. On July 30, the scope justification was updated with the same data-sharing disclosures and saved, explicitly updating the pending verification request. Verification Center shows the privacy, functionality, data-access, minimum-scope, and additional-requirements reviews in progress.
- Replies with the requested remediation were sent directly to the latest July 24 and July 30 reviewer messages in the original thread.
- Google requires an annual ADA-CASA AL1 assessment by October 28, 2026. On July 30, the original reviewer thread was asked to confirm Mailroom's eligibility for the no-cost AL1 path before any lab is selected or paid. A reply is pending.
- The current CASA 2.1.1 specification describes web applications and web-accessible APIs, while Mailroom is a local desktop MCP process with no backend. The reviewer or assigned lab must confirm the applicable assessment profile and which web-only controls should be marked not applicable.
- The public privacy policy and terms now require an AI client configuration that does not use submitted Gmail content to train generalized models, closing the gap between Google's Limited Use requirement and optional consumer AI model-improvement settings.

## Before approval

1. [x] Verify `jacobkieser.me` for the `JacbK` GitHub account, then configure `mailroom.jacobkieser.me` as the repository's GitHub Pages custom domain.
2. [x] Add a Namecheap BasicDNS CNAME with host `mailroom` and value `jacbk.github.io`, then enable HTTPS after GitHub provisions the certificate.
3. [x] Confirm every homepage, privacy, terms, canonical, and plugin-manifest URL uses `mailroom.jacobkieser.me`.
4. [x] Update Branding in Google Cloud Console and verify the owned domain in Search Console with DNS.
5. [x] Keep the Desktop client used by `shared-client.ts`, rename it `Mailroom Desktop`, and delete the unused Desktop client.
6. [x] Upload a continuous full-motion YouTube demo in English showing:
   - the complete Google consent flow with “Show all services” expanded and `gmail.modify` readable;
   - the exact same scope in Mailroom and Cloud Console;
   - connecting both Gmail accounts;
   - search, read, attachment, labels, draft create/update/list/send, direct send, forward, archive, and Trash;
   - each write reflected in the source Gmail account;
   - `./setup --doctor`, macOS Keychain storage, and uninstall/revoke.
7. [x] Add the new video URL to Data Access, confirm the verification request is in progress, and reply directly to the latest reviewer message with the video and privacy remediation.
8. [x] Confirm whether a no-cost self-assessment remains available. Google said it does not.
9. [x] Replace shared OAuth as the launch path with guided personal OAuth.
10. [ ] After confirming migration, cancel the verification request and remove the legacy production OAuth client in Google Cloud Console.

Do not advertise shared OAuth. Personal-use OAuth is the supported launch path.
