# Fork workflow (Hanson's fork)

This fork tracks [upstream LearnHarness](https://github.com/amosblomqvist/learnharness) and adds Hanson's features. Keep it one codebase, cheap to sync, and always deployable.

## One codebase
- The source of truth is `github.com/bbMisk/learnharness`. Work in a checkout under `~/dev`, never in an iCloud-synced folder such as `~/Documents`: sync creates duplicate files like `jobs 2.ts`.
- Nothing runs on the local host that is not a pushed commit. `scripts/deploy-local.sh` enforces this.

## Beta, then main
1. Branch from `main`, make the change, and run `npm test`, `npm run typecheck` and `npm run lint`.
2. Push the branch, then run `scripts/deploy-local.sh`. The desktop app talks to the local host (`http://127.0.0.1:8787`), so the branch is now the beta Hanson uses. The script keeps the two newest previous versions as `~/dev/learnharness-remote.before-<time>`, records the running commit in `~/dev/learnharness-remote/DEPLOYED.json`, and rolls back if the host does not come up. Open windows then show a "LearnHarness was updated · Reload" button; they never reload on their own, so nothing unsent is lost.
3. When the beta is good, open a PR and merge it to `main`.

To roll back by hand, move a `before-<time>` folder back to `~/dev/learnharness-remote`, then run `launchctl kickstart -k gui/$(id -u)/io.hanson.learnharness.remote`.

## Staying close to upstream
- Merge `upstream/main` every few days; small merges stay trivial.
- Put fork features in fork-owned files. Inside upstream files, keep edits to small hooks.
- Send general fixes upstream as PRs instead of carrying them here.
- Format fork-owned files only, never upstream ones: `npx prettier@3.6.2 --use-tabs --tab-width 4 --print-width 140 --write <files>`.
