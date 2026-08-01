# Use your own Google app

Mailroom uses its shared Google app by default. Use your own if shared sign-in is blocked or you want the OAuth client under your Google Cloud project.

1. Create a Google Cloud project and [enable the Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
2. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) and configure Branding.
3. Under Audience, choose External. If the app is in Testing, add every Gmail account you plan to connect as a test user.
4. Under Data Access, add [`https://www.googleapis.com/auth/gmail.modify`](https://developers.google.com/workspace/gmail/api/auth/scopes).
5. Under Clients, create a **Desktop app** OAuth client and download its JSON.
6. Run:

```sh
git clone https://github.com/JacbK/mailroom.git ~/.mailroom
~/.mailroom/setup --self-host ~/Downloads/google-oauth.json
```

Mailroom moves the OAuth client into macOS Keychain, deletes the downloaded file, and opens Google sign-in for each account.

`gmail.modify` is a restricted scope. A personal app can stay in Testing if every account is a test user, but its refresh tokens expire after seven days. Publish it to Production for persistent access or for accounts outside the test-user list. Google may show an unverified-app warning unless the project completes verification.

Switch back to the Mailroom app with:

```sh
~/.mailroom/setup --shared
```

Switching apps reconnects every configured account. Mailroom keeps the old app active unless every sign-in succeeds.
