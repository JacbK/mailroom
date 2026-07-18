# Use your own Google app

1. Create a Google Cloud project and enable the Gmail API.
2. Configure an External OAuth consent screen with `gmail.modify`.
3. Create a Desktop OAuth client and download its JSON.
4. Run:

```sh
./setup --self-host ~/Downloads/google-oauth.json
```

Setup moves the client into macOS Keychain, deletes the downloaded file, and opens Google sign-in for each account. If the app stays in Testing, add every Gmail address as a test user. For long-lived tokens, publish the app to Production.

Switching apps asks you to reconnect every configured account. The old setup stays active unless every sign-in succeeds.

Switch back later with:

```sh
./setup --shared
```
