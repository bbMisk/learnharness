# Desktop builds and releases

## Platforms

| Platform | Build runner | Packages | In-app update |
|---|---|---|---|
| macOS, Apple Silicon | `macos-26` (arm64) | signed/notarized DMG + ZIP | ZIP via Squirrel.Mac |
| Windows, x64 | `windows-2025` | unsigned per-user NSIS installer | NSIS |
| Linux, x64 | `ubuntu-24.04` | AppImage + `.deb` | AppImage replacement; `.deb` through dpkg/apt with elevation if needed |

Windows signing is deliberately disabled. SmartScreen may warn about an unknown publisher on initial installation. AppImage is the primary Linux download because it is self-contained and updates without administrator permission. `.deb` updates may request an administrator password. Both use the same download/restart banner. Package targets and signing settings live in [`electron-builder.yml`](../electron-builder.yml); see [`package.json`](../package.json) and the lockfile for current tool versions.

The custom app bar stays on all three platforms. macOS keeps its left-side traffic lights; Windows/Linux use Electron's native right-side Window Controls Overlay, with CSS space reserved from the overlay's actual geometry. Windows/Linux hide the native menu until Alt is pressed. macOS keeps its system menu.

Icons are per-platform (2026-10-13): macOS compiles the Icon Composer document `build/icon.icon` via actool into `Assets.car` (macOS 26 Liquid Glass) plus a fallback icns that `scripts/after-pack.cjs` replaces with the hand-packed full-res `build/icon.icns` (actool's caps at 256px); Windows embeds `build/icon.ico` and Linux uses `build/icon.png`, both generated from the flat design (`build/icon-flat.svg`) by `node scripts/make-icons.mjs`. Building the mac icon needs **macOS 26+ and Xcode 26+** (`actool`): Xcode 26's asset compiler crashes on macOS 15 because its host frameworks lack required symbols. `desktop:dist` injects `DEVELOPER_DIR` locally; release packaging uses `macos-26` and selects Xcode via setup-xcode. The older-OS fallback icon remains included. Linux's desktop identity is `learnharness.desktop`. Public package-maintainer metadata uses the owner's GitHub no-reply address; support goes through [GitHub Issues](https://github.com/amosblomqvist/learnharness/issues).

## Build pipeline

CI uses Node 26. Each OS installs its own dependencies and builds its own Next standalone tree:

1. `npm ci`
2. Native PDF/SVG renderer and browser-service tests for that OS, running in Electron's bundled Node (no display needed).
3. `npm run build` (`output: "standalone"`).
4. `node scripts/smoke-provider-runtime.mjs` — check the fresh trace before curation: offline evaluation of all ten native Pi chat implementations, lazy Google/Bedrock initialization, and public GitHub Copilot/xAI OAuth-to-auth paths. Payload hooks stop before generation; this is not a live provider/login check.
5. `node scripts/build-server.mjs` — copy static assets, refuse leaked learning data and credential files, remove only standalone-root `dist/` and `node_modules/electron/` (old installers and the development runtime), and check prompt assets.
6. `node scripts/smoke-server.mjs --electron` — exercise demo dependencies, offline provider initialization, and gzip backpressure in Electron's bundled Node; boot the standalone server using throwaway data/auth and check `/`, `/api/graph`, `/api/models`, and `/api/settings`.
7. `npx electron-builder <platform flags> --publish <policy>` — package for the current OS using the local/rehearsal or tag-release policy below.

The shell/updater live in `app.asar`; the standalone server and native renderer binaries ship unpacked as `extraResources`. **Do not cross-build the server payload.** Next traces the build machine's native binaries, so a macOS-built standalone tree is not a Windows/Linux payload.

The release workflow additionally initializes providers from the **packaged** payload under both host Node and the packaged Electron runtime, then exercises the demo browser helper using the app's own Electron (Linux uses Xvfb). Successful HTTP boot or a model catalog alone does not prove those lazy runtime paths work.

### Runtime tracing and image payloads

[`next.config.ts`](../next.config.ts) keeps Pi, PDF.js, canvas, resvg, and Photon external and explicitly includes dynamically loaded catalogs, OAuth modules, renderer binaries, image workers, and Photon WASM. Broad `dist/**` or `data/**` exclusions can strip legitimate dependencies; keep the narrow tracing rules and post-trace curation in [`build-server.mjs`](../scripts/build-server.mjs). That script refuses known root data/secret leaks; it is not a substitute for inspecting a changed payload.

Image resizing uses the shipped Photon 0.3.4 JS/WASM engine and unbundled worker, alongside native canvas PDF and resvg SVG rendering. [`smoke-image-runtime.mjs`](../scripts/smoke-image-runtime.mjs) is an additional focused offline check, **not currently invoked by CI/release workflows**: it generates a synthetic PNG and proves in-process and worker resizing resolve inside the standalone payload. It accepts `--standalone <dir>` and `--runtime <Node-or-Electron-binary>` like the provider probe. No real provider or personal image is needed.

### Local packaging

`npm run desktop:dist` is the local macOS signing path, using the `LH_NOTARY` keychain profile. It clears local `dist` and `.next/standalone`, builds, checks the fresh provider trace, curates the payload, runs the server smoke under host Node, then packages. Unlike CI's `--electron` smoke, that script does not itself check Electron's Node runtime or run the post-package probes. It has no publish flag and is not the tag-upload workflow.

For a local Windows/Linux build, run steps 1–6 above, then:

```sh
# On Windows:
npx electron-builder --win --x64 --publish never

# On Linux:
npx electron-builder --linux --x64 --publish never
```

## CI vs release

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on main pushes, pull requests, and manual dispatch:

- Typecheck, full deterministic test suite, and lint on Ubuntu.
- Native renderer/browser-service tests, fresh-trace provider gate, and standalone build/boot-smoke on macOS (`macos-15`), Windows, and Linux. This macOS job does not compile the Icon Composer asset; only release packaging needs the newer runner.

[`.github/workflows/release.yml`](../.github/workflows/release.yml) has two deliberately separate modes:

- **Manual / Run workflow:** unsigned rehearsal installers saved as workflow artifacts for 7 days. No signing secrets needed, no release created, and nothing published. macOS notarization is skipped; these are not production macOS installers.
- **Push `v<package.json version>`:** gates first, then one job creates or reuses a **single draft GitHub Release** before the three OS jobs package/upload their artifacts and update metadata in parallel. This avoids competing draft creation. A published or ambiguous existing release fails the preparation step instead of being modified. Separate runs for the same ref are serialized, never cancelled mid-upload. The tag must match the package version. macOS must sign and notarize successfully; missing secrets fail loudly. The workflow never publishes the draft. After all three packaging jobs succeed, a final read-only **Verify draft release** job (below) fails the run unless that draft is complete and self-consistent.

The three jobs upload distinct updater feeds: `latest-mac.yml`, `latest.yml`, `latest-linux.yml`, with the matching ZIP/NSIS/AppImage/deb assets and blockmaps. **A partially populated draft is never fit to publish — and the final job enforces it mechanically.** The app reads the public GitHub release feed anonymously; no release token is baked into the app. Draft uploads are not public updates. **Only the owner publishes the verified draft.**

### The verification job

`verify` runs only on tag pushes (`needs: package`, so after **all three** packaging legs; manual rehearsals create no draft and skip it). It checks out the tagged revision without persisting credentials and runs [`scripts/verify-release.ts`](../scripts/verify-release.ts). GitHub requires push access to list **draft** releases, so this job needs `contents: write` even though every API operation is GET-only. The token is exposed only to the release-list and feed-download steps, not dependency installation or the offline validator. The validator:

- finds the draft using the same tag matching as the draft job and electron-builder's publisher — `tag_name` equals `v<version>` **or** the bare `<version>`; zero matches, two matches, or an already-published match fail the run, and a draft matched only via the unprefixed form is flagged with a warning (a later run could create a second draft under the `v`-tag and split the assets — rename before publishing);
- fails unless the release holds **exactly** these 11 assets — nothing missing, nothing extra (a stale name from an older run is an error), nothing zero-size, nothing still in a non-`uploaded` state:

| Asset | Role |
|---|---|
| `LearnHarness-<v>-arm64.dmg` + `.blockmap` | macOS installer |
| `LearnHarness-<v>-arm64-mac.zip` + `.blockmap` | macOS updater payload (Squirrel.Mac installs from the ZIP) |
| `LearnHarness-<v>-x64-setup.exe` + `.blockmap` | Windows NSIS installer |
| `LearnHarness-<v>-x86_64.AppImage` | Linux AppImage (no sidecar blockmap) |
| `LearnHarness-<v>-amd64.deb` | Linux deb (no sidecar blockmap) |
| `latest-mac.yml` / `latest.yml` / `latest-linux.yml` | updater feeds |

  (The Linux names are deliberate: `linux.artifactName` applies to both targets, and `${arch}` expands to `x86_64` for AppImage and `amd64` for deb. The validator fails closed if `electron-builder.yml` drifts from the verified shapes.);
- downloads the three feeds from the draft and fails unless each parses, carries the `package.json` version, and references **exactly** the uploaded assets — by bare file name only (no paths, traversal, or URLs), with sizes matching the API-reported asset sizes, the ZIP first in `latest-mac.yml`, and the legacy top-level `path`/`sha512` backed by that first entry.

The job only reads (release list + asset downloads); it never creates, edits, publishes, or deletes anything.

## macOS CI secrets

Add these under repository **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application `.p12` backup, including its private key |
| `MAC_CSC_KEY_PASSWORD` | Password protecting that `.p12` |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | `JS6XN22HY6` |

The workflow maps the certificate secrets to electron-builder's `CSC_LINK` / `CSC_KEY_PASSWORD`. GitHub's built-in `GITHUB_TOKEN` supplies `GH_TOKEN` with job-scoped `contents: write`; no separate GitHub token secret is required. Signing credentials are present only for the packaging step, not the Next build. Never commit certificates, passwords, or `.env.local`.

## Release runbook

1. Agree the release scope/version and finish the relevant checks and human functional acceptance. Use the manual workflow when rehearsal installers are needed; a rehearsal is not a production macOS signing check.
2. Update `package.json` and the lockfile to the agreed version. Run the normal gates, ensure the intended source is on main, and push the authorized matching `v<version>` tag. Confirm signing/notarization secrets are configured before a production macOS build.
3. Wait for **all three** packaging jobs **and Verify draft release**. Inspect the single draft's notes, tag, 11 assets, and three feeds. If a gate fails, diagnose before retrying or publishing; re-uploads replace same-named assets, but stale extra assets fail validation. Do not treat deletion, cleanup, or publication as a harmless verification step.
4. If an authorized draft metadata edit is needed, **include the explicit canonical `tag_name: "v<version>"` in every metadata PATCH**, even when changing only the title/body. Omitting it has reset release tags in past releases. Re-read the draft afterward to confirm tag identity, draft status, and assets. A tag correction is a metadata change, not permission to delete/recreate a release.
5. Owner checks the actual packaged build as needed and explicitly publishes the complete draft. Confirm public installer/update-feed availability and the website download links. Use a prior installed version when checking the real update path.

Changes to the shell, native modules, packaging/updater configuration, or Electron itself warrant relevant platform smoke checks: install/open, window controls/dragging, zoom, setup and session resume, native PDF/SVG tools, and the demo helper. Offline fixture gates prove their exercised paths, not real account/provider functionality; do not repeat already accepted feature testing without a concrete risk.

## Unsigned macOS releases (self-updater)

There is no Apple Developer ID on the release Mac and GitHub Actions is off, so macOS releases are built and uploaded from the Mac with `npm run release:mac` ([`scripts/release-mac.mjs`](../scripts/release-mac.mjs), config [`electron-builder.unsigned-mac.yml`](../electron-builder.unsigned-mac.yml)).

1. Set the new version in `package.json` and the lockfile, run the normal gates, commit, and push to `main`. Each release needs a new version: the script refuses a tag that already has a release.
2. `npm run release:mac` is a **dry run**. It builds the app (ad-hoc signed, not notarized), checks `codesign -dv` reports `Signature=adhoc`, runs `codesign --verify --deep --strict`, checks `latest-mac.yml` against the ZIP's size and sha512, and lists what it would upload from `dist/release-mac/`: the DMG and ZIP with their blockmaps, `latest-mac.yml`, and a copy of the DMG named `LearnHarness-arm64.dmg`.
3. `npm run release:mac -- --publish` first refuses if `v<version>` already exists on GitHub pointing at another commit, or if the current latest release carries `latest.yml` or `latest-linux.yml`. Windows and Linux copies follow the latest release, so a macOS-only latest release would break their updates; none have shipped yet. It then does the same build, pins the tag to the built commit with a plain (never forced) `git push`, reads the tag back from GitHub and re-checks the latest release, and runs `gh release create v<version> --latest --verify-tag` on `bbMisk/learnharness` with all six files. That is a normal release, not a draft or prerelease, so `releases/latest` points at it. It needs a clean tree, `origin` set to `bbMisk/learnharness` for both fetch and push with the commit pushed to one of its branches, and `gh` signed in.

Downloads from the website stay at <https://github.com/bbMisk/learnharness/releases/latest/download/LearnHarness-arm64.dmg>. The first time someone opens a downloaded copy, macOS says it can't check the app; they open System Settings → Privacy & Security and choose Open Anyway.

How the installed app updates: the release config adds `lhMacUpdater: "self"` to the packaged `package.json`, which switches macOS to [`electron/mac-self-updater.cjs`](../electron/mac-self-updater.cjs). Squirrel.Mac won't install unsigned updates. A build without that flag, such as a Developer ID build from `electron-builder.yml`, goes back to electron-updater. Windows and Linux are unchanged. The self-updater:

- checks `latest-mac.yml` from `releases/latest/download/` about 10 seconds after launch and every 4 hours, plus manual checks. It honours the Automatic updates switch and only takes newer versions (SemVer, prereleases included);
- first checks the app can replace itself. If the app runs from a disk image or App Translocation, the card says "Move LearnHarness to Applications to get updates". If its folder isn't writable, the card links "Download update" to the permanent DMG, and Settings → General keeps the same link while that state lasts;
- downloads the ZIP to a temp folder and checks its size and sha512. It extracts the ZIP with `ditto`, refuses an app that is a link or holds links pointing outside itself, and checks the bundle ID and version. Any failure means nothing is installed and the temp folder is deleted. Quitting mid-download cancels it and deletes the partial files, and a later launch removes download folders left by a crash;
- installs when the user clicks **Restart to update** (then relaunches) or quits normally (no relaunch). A detached shell helper waits for the app to exit, moves the old app to a hidden sibling backup, and moves the new one into place. If that fails, it puts the old app back. The new version deletes the backup the first time it starts (if that fails, it retries on the next launch). Each install location has its own marker in userData, so two copies sharing a data folder never clear each other's. The helper writes its log to `userData/logs/update-helper.log`;
- if someone opens the old copy while the helper is still swapping, that copy waits for the helper (up to the 10-minute install window) and then relaunches the installed version, so the backup is always cleaned up;
- if a shutdown or logout signals the helper between its two moves, it puts the old app back first. Only a power cut or SIGKILL in that sub-millisecond gap can leave the app path empty; the previous version is then in the hidden `.LearnHarness.app.update-backup-*` folder next to it, and the helper log names it;
- `LH_UPDATE_FEED` points the check at a local folder for a drill, and `LH_USER_DATA_DIR` keeps the drill's data separate. The relaunch passes both on.

The 0.4.0-preview.2 app has no update feed, so its users reinstall once from the DMG.

## In-app updates and website notification

Packaged apps check at startup and every 24 hours by default (unsigned macOS builds: about 10 seconds after startup and every 4 hours, see above; Settings shows the active interval), download available updates automatically, and install downloaded updates on quit or through Restart. **Settings → General** shows version/release notes, manual Check for updates, status, and Automatic updates. Turning automatic checks off does not cancel downloads or staged installs; a manual check still downloads available updates. Development builds disable the updater. Errors are logged to `userData/logs/main.log` without taking down the app. The test-only `LH_UPDATE_FEED` environment override points to a generic feed for an authorized local update drill.

Sources: [`electron/main.cjs`](../electron/main.cjs), [`electron/preload.cjs`](../electron/preload.cjs), and [`update-settings.tsx`](../components/settings/update-settings.tsx).

After a stable release is published, [`.github/workflows/notify-website.yml`](../.github/workflows/notify-website.yml) dispatches `desktop-release-published` with the tag to `amosblomqvist/learnharness-web`, using the separately scoped `WEBSITE_DISPATCH_TOKEN` secret. Drafts and prereleases do not trigger that job. A successful HTTP 204 means the website update was **queued**, not that deployment or public links have been verified.

That job only runs on `amosblomqvist/learnharness`. Releases from `bbMisk/learnharness` with `npm run release:mac` notify nothing: Actions is off there, and the job's repository check would skip it anyway. Their download link, `releases/latest/download/LearnHarness-arm64.dmg`, always serves the newest release, so a page that links there needs no update.
