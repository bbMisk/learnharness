#!/usr/bin/env bash
# Ship the current branch to Hanson's live setup in one command.
#
#   scripts/ship-local.sh [--force] [--no-relaunch]
#
# Run it in a normal Terminal (it needs your GitHub login and launchd).
# Order matters: everything that can fail without touching the live setup
# runs first.
#   1. build the desktop app (this also builds the server and smoke-tests it)
#   2. run the plugin browser smoke; a failure is reported, not fatal
#   3. push the branch
#   4. deploy the local host (scripts/deploy-local.sh: idle check, backup,
#      health check, automatic rollback)
#   5. install the desktop app, keeping the previous one as a backup
#   6. quit and reopen the app, unless --no-relaunch
#
# --force is passed to deploy-local.sh (skip its idle and pushed checks).
set -euo pipefail

APP_DEST="${LH_APP_DEST:-/Applications/LearnHarness.app}"
BACKUP_ROOT="${LH_APP_BACKUP_ROOT:-$HOME/dev}"
DEPLOY="${LH_DEPLOY_CMD:-scripts/deploy-local.sh}" # overridable so the script can be rehearsed
FORCE=""
RELAUNCH=1
for arg in "$@"; do
	case "$arg" in
		--force) FORCE="--force" ;;
		--no-relaunch) RELAUNCH=0 ;;
		*) echo "ship-local: unknown option $arg" >&2; exit 2 ;;
	esac
done

cd "$(dirname "$0")/.."
die() { echo "ship-local: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != "HEAD" ] || die "check out a branch first"
case "$BRANCH" in main | master) die "ship from a work branch, not $BRANCH" ;; esac
[ -z "$(git status --porcelain)" ] || die "uncommitted changes; commit first"
COMMIT="$(git rev-parse --short HEAD)"
[ -d node_modules ] || npm ci

step "1/6 build the desktop app ($BRANCH @ $COMMIT)"
npm run desktop:local
APP="$(node -p 'require("./dist/local-build.json").app')"
VERSION="$(node -p 'require("./dist/local-build.json").version')"
[ -d "$APP" ] || die "the desktop build did not produce an app"

step "2/6 plugin browser smoke (reported, not fatal)"
SMOKE_LOG="dist/ship-browser-smoke.log"
if node scripts/smoke-server.mjs --browser >"$SMOKE_LOG" 2>&1; then
	BROWSER_SMOKE="passed"
else
	BROWSER_SMOKE="FAILED (log: $PWD/$SMOKE_LOG)"
fi
echo "browser smoke: $BROWSER_SMOKE"

step "3/6 push $BRANCH"
git push -u origin "$BRANCH"

step "4/6 deploy the local host"
$DEPLOY $FORCE

step "5/6 install LearnHarness $VERSION"
STAMP="$(date +%Y%m%d-%H%M%S)"
if [ -d "$APP_DEST" ]; then
	BACKUP="$BACKUP_ROOT/learnharness-desktop.previous-$STAMP"
	mkdir -p "$BACKUP"
	mv "$APP_DEST" "$BACKUP/"
	echo "previous app kept in $BACKUP"
fi
ditto "$APP" "$APP_DEST"
codesign --verify --deep --strict "$APP_DEST"

step "6/6 relaunch"
if [ "$RELAUNCH" = 1 ]; then
	# A normal quit, never a kill: replies run on the local host, not in the window.
	osascript -e 'tell application "LearnHarness" to quit' >/dev/null 2>&1 || true
	for _ in $(seq 1 40); do pgrep -f "$APP_DEST/Contents/MacOS/LearnHarness\$" >/dev/null || break; sleep 0.5; done
	open -a "$APP_DEST"
	echo "LearnHarness reopened"
else
	echo "skipped; quit (Cmd-Q) and reopen LearnHarness to use the new app"
fi

printf '\nship-local: %s @ %s is live (host + app %s). Browser smoke: %s\n' "$BRANCH" "$COMMIT" "$VERSION" "$BROWSER_SMOKE"
