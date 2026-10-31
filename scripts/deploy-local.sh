#!/usr/bin/env bash
# Deploy the current commit to the local LearnHarness host (the beta).
#
#   scripts/deploy-local.sh [--force]
#
# Builds this checkout, swaps the result into the host directory with a
# timestamped backup, restarts the launchd service, and rolls back if the
# host does not come back healthy. Refuses uncommitted changes, so the host
# always runs a known commit (recorded in DEPLOYED.json), and refuses to
# restart while a reply or background job is running, or deploy a commit
# that is not on GitHub, unless --force.
set -euo pipefail

HOST_DIR="${LH_HOST_DIR:-$HOME/dev/learnharness-remote}"
SERVICE="${LH_HOST_SERVICE:-io.hanson.learnharness.remote}"
PORT="${LH_HOST_PORT:-8787}"
URL="http://127.0.0.1:$PORT"
FORCE="${1:-}"

cd "$(dirname "$0")/.."
die() { echo "deploy-local: $*" >&2; exit 1; }

[ -z "$(git status --porcelain)" ] || die "uncommitted changes; commit first so the host runs a known commit"
COMMIT="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch -q origin
[ -n "$(git branch -r --contains "$COMMIT" 2>/dev/null)" ] || [ "$FORCE" = "--force" ] || die "commit ${COMMIT:0:7} is not on GitHub; push the branch first so local and GitHub stay the same"

if [ "$FORCE" != "--force" ] && curl -sf "$URL/api/health" >/dev/null; then
	BUSY="$(curl -sf "$URL/api/chats" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).chats.filter(c=>c.busy).length))')"
	JOBS="$(curl -sf "$URL/api/activity" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log(a.jobs.length+a.extractions.length+a.flashcards.length)})')"
	[ "$BUSY" = 0 ] && [ "$JOBS" = 0 ] || die "host is working ($BUSY replies, $JOBS background jobs); retry later or pass --force"
fi

npm run build
node scripts/build-server.mjs

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
STAGE="$HOST_DIR.stage-$STAMP"
BACKUP="$HOST_DIR.before-$STAMP"
cp -c -R .next/standalone "$STAGE" 2>/dev/null || cp -R .next/standalone "$STAGE"
printf '{"commit":"%s","branch":"%s","deployedAt":"%s"}\n' "$COMMIT" "$BRANCH" "$STAMP" >"$STAGE/DEPLOYED.json"

restart() {
	launchctl kickstart -k "gui/$(id -u)/$SERVICE"
	for _ in $(seq 1 60); do curl -sf "$URL/api/health" >/dev/null && return 0; sleep 0.5; done
	return 1
}

[ -d "$HOST_DIR" ] && mv "$HOST_DIR" "$BACKUP"
mv "$STAGE" "$HOST_DIR"
if restart; then
	echo "deploy-local: $BRANCH @ ${COMMIT:0:7} is live on $URL"
	[ -d "$BACKUP" ] && echo "deploy-local: previous version kept in $BACKUP"
else
	echo "deploy-local: host unhealthy after restart; rolling back" >&2
	mv "$HOST_DIR" "$HOST_DIR.failed-$STAMP"
	[ -d "$BACKUP" ] && mv "$BACKUP" "$HOST_DIR"
	restart || die "rollback also failed; check the service logs"
	die "rolled back to the previous version; the failed build is in $HOST_DIR.failed-$STAMP"
fi
