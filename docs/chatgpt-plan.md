# ChatGPT plan support in the Hanson fork

This fork adds **Continue with ChatGPT** to first-run setup and Settings → Keys. It uses OpenAI's documented public-client subscription authorization and the public Responses API. No OpenAI API key or copied Codex credentials are required.

## Run locally

### Native macOS app

`npm run desktop:local` produces `LearnHarness.app` with an ad-hoc local signature. The verified bundle is built in the system temporary directory; `dist/local-build.json` records its path. This avoids file-provider Finder metadata being added to signed app bundles under Documents. Install the result in Applications and keep signed bundles outside Documents. The build does not use the upstream developer's signing identity or notarization. This fork is identified as `0.3.4-hanson.1`, keeps the existing LearnHarness application identity and data directory, and disables upstream automatic updates so they cannot overwrite the fork. The app menu's update action explains how to update from this fork.

The local build retains hardened runtime and adds `disable-library-validation` for this app and its helpers: ad-hoc signatures have no shared Team ID for loading Electron frameworks and native modules. This is a local-build entitlement, separate from the upstream Developer ID entitlement file.

Install the completed app in Applications after quitting the previous copy and keeping a rollback copy. Existing desktop learning data and provider keys remain in `~/Library/Application Support/LearnHarness/`. The separate browser launcher below still uses `LearnHarness-Hanson`.

### Browser launcher

Use a supported Node.js release (Node 24 was used for validation):

```sh
npm ci
npm run build
node scripts/build-server.mjs
node scripts/start-local.mjs
```

The launcher binds only to `127.0.0.1:3027` and opens a browser. Keep its terminal open; Ctrl+C stops it. Set `LH_LOCAL_PORT` if that port is occupied. On macOS, the fork's data is under `~/Library/Application Support/LearnHarness-Hanson/`, separate from the official app's `LearnHarness` directory. Run this fork through its local launcher, not the official installed app.

In setup, choose **Continue with ChatGPT**. Complete account selection and consent in your browser, then return to the app, dismiss the first-use notice, and choose Strong, Cheap, and Vision models. Saving models does not start a lesson. Both teaching and background roles use their selected models through the existing slot resolution.

## Accounts, credentials, and usage

- The host has a stable opaque ID; each account/workspace registration retains its own issued client ID and tokens. Reconnect reuses that registration. Sign-out retains its mapping for later sign-in.
- Tokens remain in a separate `chatgpt/accounts.json` beside the API-key file. The directory is `0700` and atomic file writes use `0600` on Unix. This is protected local plaintext, not Keychain encryption. Refresh and credential writes use a cross-process file lock.
- OAuth uses PKCE, state, nonce, a loopback callback, and signed ID-token verification against OpenAI's JWKS. The app never imports credentials from another application.
- Sign-out attempts remote session revocation before clearing local tokens. If it cannot confirm revocation, the UI says so and directs you to ChatGPT settings. Temporary refresh errors preserve credentials; terminal invalidation clears unusable tokens.
- The model picker intersects the signed-in account's visible models with the installed model library's known models. Unrecognized future models are omitted until the library is updated. Account switching refreshes the model list.
- Requests use `https://api.openai.com/v1/responses`, `store:false`, and `stream:true`. Local function tools are namespaced. Unsupported subscription request fields are removed. Incomplete, failed, or interrupted streams do not count as successful responses. There is no automatic fallback to paid API-key usage.
- **Using ChatGPT plan** appears beside the model selector. **Manage usage** opens https://chatgpt.com/settings/usage. Subscription turns have no API dollar estimate; existing API-key providers retain their normal accounting. Credits can be consumed only according to permissions granted in ChatGPT.
- This integration does not provide device synchronization. It does not add subscription access to dictation services, external web-search services, or hosted image generation.

## Validation and live authorization

The deterministic suite tests OAuth identity and state validation, scope gating, rotating refresh serialization, revocation, model filtering, request shaping, teaching tool replay, incomplete streams, and the setup confirmation UI. These use disposable fixture credentials and no live model calls. A real account authorization and completed lesson are separate acceptance checks; passing offline tests does not establish account eligibility or successful live inference.

The existing upstream sidebar date test depends on the host timezone: a January 2 UTC timestamp renders January 1 in America/New_York. That pre-existing assertion is unchanged in this fork.

The upstream dependency audit reported 15 findings before this change (1 moderate, 10 high, 4 critical), and adding these dependencies left that count unchanged. This fork does not include unrelated dependency upgrades or claim to resolve those findings.

## Official integration references

- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/ui-ux-guidelines

The upstream project is AGPL-3.0-only; its license and attribution are retained.
