# Fork workflow (Hanson's fork)

This fork tracks [upstream LearnHarness](https://github.com/amosblomqvist/learnharness) and adds Hanson's features. Keep it one codebase, cheap to sync, and always deployable.

## One codebase
- The source of truth is `github.com/bbMisk/learnharness`. Work in a checkout under `~/dev`, never in an iCloud-synced folder such as `~/Documents`: sync creates duplicate files like `jobs 2.ts`.
- Nothing runs on the local host that is not a pushed commit. `scripts/deploy-local.sh` enforces this.

## Beta, then main
1. Branch from `main`, make the change, and run `npm test`, `npm run typecheck` and `npm run lint`.
2. Push the branch, then run `scripts/deploy-local.sh`. The desktop app talks to the local host (`http://127.0.0.1:8787`), so the branch is now the beta Hanson uses. The script keeps the two newest previous versions as `~/dev/learnharness-remote.before-<time>`, records the running commit in `~/dev/learnharness-remote/DEPLOYED.json`, and rolls back if the host does not come up or its chat list is not readable JSON. Open windows then show "LearnHarness updated · Reload" at the bottom left (above Settings in the sidebar, or as a small pill when the sidebar is closed); they never reload on their own, so nothing unsent is lost.
3. When the beta is good, open a PR and merge it to `main`.

`scripts/ship-local.sh` does step 2 and the desktop app in one command: it builds and smoke-tests the app (a browser smoke failure stops it before anything is pushed), pushes the branch, runs `deploy-local.sh`, installs the app into `/Applications` (the previous one is kept in `~/dev/learnharness-desktop.previous-<time>`), then quits and reopens it. Run it in a normal Terminal. A change that touches `electron/` needs the new app, not only the host.

To roll back by hand, move a `before-<time>` folder back to `~/dev/learnharness-remote`, then run `launchctl kickstart -k gui/$(id -u)/io.hanson.learnharness.remote`.

The host's launchd job (`~/Library/LaunchAgents/io.hanson.learnharness.remote.plist`) must set `ProcessType` to `Interactive`. Without it, launchd throttles the job like background work, and when the Mac is busy a chat page can take 20 s or more to open.

## Staying close to upstream
- Merge `upstream/main` every few days; small merges stay trivial.
- Put fork features in fork-owned files. Inside upstream files, keep edits to small hooks.
- Send general fixes upstream as PRs instead of carrying them here.
- Format fork-owned files only, never upstream ones: `npx prettier@3.6.2 --use-tabs --tab-width 4 --print-width 140 --write <files>`.

## What makes upstream merges expensive
Measured over the v0.6.1 merge (434 conflict hunks) and the v0.7.0 merge (119). Avoid these inside upstream-owned files:
- Rewriting comments or wording. One comment-only commit produced most of the v0.7.0 hunks in four components.
- Moving upstream code into new fork files (`chat.tsx` into `dock-overlay.tsx` and `transcript-render.tsx`, the settings dialog into a lazy body). Every later upstream change there is ported by hand.
- Changing behaviour in place where a fork-owned file and a one-line hook would do. `electron/fork-config.cjs` holds fork on/off switches for that purpose.
- A fork lint rule that upstream tests break (`assertSameNode`): each merge rewrites upstream test assertions.

## Standing decisions
Owner priorities (2026-11-22): simple to use, snappy, polished, easy to merge upstream. Where the fork and upstream both changed a behaviour, the fork's wins unless upstream's change is a bug, security or performance fix.
- Side chat: the fork's side tutor. Upstream's side questions are left out, including their fixes.
- Flashcards: upstream's core plugin. The fork's old flashcard files in the data folder are never read, rewritten or deleted.
- Appearance: upstream's themes.
- Sidebar: Projects are the only grouping. Upstream's session folder tree (`components/sidebar-folders.tsx`) is kept unmodified but not mounted; the graph's folder filter is in. Planned: rebuild Projects on upstream's folders so the sidebar is upstream's component.
- Settings prompts: upstream's per-segment editor and its "Discard changes?" prompt; the fork keeps only the two-click delete.
- Question-tool prompts: upstream's wording (no fork turn rule).
- Startup announcements from learnharness.ai: off (`electron/fork-config.cjs`), because they advertise upstream builds that lack the fork's features.
- Shortcuts stay blocked while a modal is open, and Escape reverts an invalid Settings number; `scripts/smoke-plugin-browser.mjs` asserts the fork's behaviour for those steps.
- `proxy.ts`: `remoteAccessError` first; API calls through the Tailscale host use `desktopAPIAuthorized`; every other API call uses upstream's `apiRequestRefusal`.
