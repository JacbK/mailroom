# Connect your personal Google app

Mailroom keeps every Gmail feature by using a personal Google OAuth app that belongs to you. Google says personal-use projects with fewer than 100 users do not need verification. You may see an unverified-app warning because Google has not reviewed your private project.

## Let Mailroom guide you

Run setup with every account you want:

```sh
~/.mailroom/setup --personal \
  --account personal=you@gmail.com \
  --account work=you@company.com
```

Mailroom opens the [browser guide](https://mailroom.jacobkieser.me/google.html) and watches your Downloads folder. When Google downloads the Desktop OAuth JSON, Mailroom validates it, moves it into macOS Keychain, deletes the downloaded copy, and continues with each Google sign-in.

## What the Google screens need

1. [Create a Google Cloud project](https://console.cloud.google.com/projectcreate). Call it `Mailroom Personal`.
2. [Enable the Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) in that project.
3. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview). Set the app name to `Mailroom Personal`, choose your email addresses, and select **External** unless this is an internal Workspace app.
4. Under [Data Access](https://console.cloud.google.com/auth/scopes), add `https://www.googleapis.com/auth/gmail.modify`.
5. Under [Audience](https://console.cloud.google.com/auth/audience), click **Publish app** so the status is **In production**. Do not submit it for verification. Testing mode makes Gmail refresh tokens expire after seven days.
6. Under [Clients](https://console.cloud.google.com/auth/clients), create a **Desktop app** named `Mailroom on my Mac`, then download its JSON. Mailroom will see the download and continue.

During Gmail sign-in, Google may show “Google hasn’t verified this app.” Choose **Advanced**, continue to `Mailroom Personal`, review the permission, and allow it. This warning is expected for a personal project.

## Work or school Gmail

If everyone is in one Google Workspace organization, the project owner can choose **Internal** instead. Internal apps do not need verification, do not show the unverified warning, and work only for accounts in that organization.

Some organizations block unverified apps. Their Google Workspace admin can either create an internal project or mark the personal OAuth client as trusted.

## Manual import

If the JSON did not download to `~/Downloads`, pass its exact path:

```sh
~/.mailroom/setup --self-host /path/to/client_secret.json
```

Mailroom reconnects every configured account before switching clients. If any sign-in fails, the old configuration stays active.

References: [Google's personal-use exception](https://support.google.com/cloud/answer/13464323), [publishing status and token lifetime](https://support.google.com/cloud/answer/15549945), and [Gmail scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes).
