# ChatGPT account setup

This fork uses the current upstream LearnHarness ChatGPT connection. In setup or Settings → Providers, connect your own account and approve plan use. Select your models explicitly. API-key providers remain available; a failed subscription request never falls back to paid API-key usage.

Credentials are stored in the upstream private `chatgpt-credentials.json` beside the app’s `auth.json`, outside learning data. This is local plaintext with restricted file permissions, not Keychain encryption. The desktop main process owns authentication and shares short-lived credentials with its private server through IPC. Browser mode uses the same owner implementation on the server. The app never imports another app’s credentials.

The account’s visible model catalog determines availability. New IDs appear when discovery supplies sufficient capabilities; incomplete unknown models are omitted rather than assigned guessed limits. Fast is opt-in and offered only when the selected model advertises a compatible service tier. The UI distinguishes the requested tier from observed delivery; Fast can be served at Standard speed.

Shared-host clients use the host’s accounts and learning data. Complete account sign-in in a browser on the machine running that host. Separate local installations keep separate accounts and histories.

## Build this fork

Use Node 24 or 26, run `npm ci`, then `npm run desktop:local`. The command builds an ad-hoc signed macOS app and records its path in `dist/local-build.json`. It does not require the upstream developer’s Apple credentials. Install in Applications after quitting the old copy. Local preview builds have no automatic updater feed; signed releases can use the existing updater configured for `bbMisk/learnharness`.

Deterministic tests use fixture credentials and no live model calls. Passing them does not establish account eligibility or successful live inference.
