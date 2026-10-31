#!/usr/bin/env bash
# Deploy the current commit to the local LearnHarness host (the beta).
#
#   scripts/deploy-local.sh [--force]
#
# Builds this checkout, swaps the result into the host directory with a
# timestamped backup, restarts the launchd service, and rolls back if the
# host does not come back healthy. Refuses uncommitted changes, so the host
# always runs a known commit (recorded in DEPLOYED.json), and refuses to
# restart while a reply or background job is running or a chat was active in
# the last 5 minutes (LH_DEPLOY_QUIET_MINUTES), or deploy a commit
# that is not on GitHub, unless --force.
set -euo pipefail

HOST_DIR="${LH_HOST_DIR:-$HOME/dev/learnharness-remote}"
SERVICE="${LH_HOST_SERVICE:-io.hanson.learnharness.remote}"
PORT="${LH_HOST_PORT:-8787}"
URL="http://127.0.0.1:$PORT"
FORCE="${1:-}"
QUIET_MINUTES="${LH_DEPLOY_QUIET_MINUTES:-5}"

cd "$(dirname "$0")/.."
die() { echo "deploy-local: $*" >&2; exit 1; }

[ -z "$(git status --porcelain)" ] || die "uncommitted changes; commit first so the host runs a known commit"
COMMIT="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch -q origin
[ -n "$(git branch -r --contains "$COMMIT" 2>/dev/null)" ] || [ "$FORCE" = "--force" ] || die "commit ${COMMIT:0:7} is not on GitHub; push the branch first so local and GitHub stay the same"

# A restart kills in-flight replies, compactions and background jobs.
assert_idle() {
	[ "$FORCE" = "--force" ] && return 0
	curl -sf "$URL/api/health" >/dev/null || return 0
	local busy jobs
	busy="$(curl -sf "$URL/api/chats" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).chats.filter(c=>c.busy||c.compacting).length))')"
	jobs="$(curl -sf "$URL/api/activity" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log(a.jobs.length+a.extractions.length+a.flashcards.length)})')"
	[ "$busy" = 0 ] && [ "$jobs" = 0 ] || die "host is working ($busy replies, $jobs background jobs); retry later or pass --force"
	# Someone may be mid-lesson (reading, about to submit) even when nothing runs.
	local recent
	recent="$(curl -sf "$URL/api/chats" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).chats.filter(c=>Date.now()-Date.parse(c.updatedAt)<'"$((QUIET_MINUTES * 60000))"').length))')"
	[ "$recent" = 0 ] || die "a chat was active in the last $QUIET_MINUTES minutes; retry when the host is quiet or pass --force"
}

assert_idle
npm run build
node scripts/build-server.mjs

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
STAGE="$HOST_DIR.stage-$STAMP"
BACKUP="$HOST_DIR.before-$STAMP"
cp -c -R .next/standalone "$STAGE" 2>/dev/null || cp -R .next/standalone "$STAGE"
printf '{"commit":"%s","branch":"%s","deployedAt":"%s"}\n' "$COMMIT" "$BRANCH" "$STAMP" >"$STAGE/DEPLOYED.json"
assert_idle || { rm -rf "$STAGE"; exit 1; } # again, just before the swap: work may have started during the build

restart() {
	# Without this, a failed restart leaves the old server answering health checks.
	launchctl kickstart -k "gui/$(id -u)/$SERVICE" || return 1
	for _ in $(seq 1 60); do curl -sf "$URL/api/health" >/dev/null && return 0; sleep 0.5; done
	return 1
}

[ -d "$HOST_DIR" ] && mv "$HOST_DIR" "$BACKUP"
mv "$STAGE" "$HOST_DIR"
if restart; then
	echo "deploy-local: $BRANCH @ ${COMMIT:0:7} is live on $URL"
	[ -d "$BACKUP" ] && echo "deploy-local: previous version kept in $BACKUP"
	# Keep the two newest backups; older ones only cost disk (each is ~370 MB).
	{ ls -dt "$HOST_DIR".before-* 2>/dev/null || true; } | tail -n +3 | while IFS= read -r old; do rm -rf -- "$old"; done
else
	echo "deploy-local: host unhealthy after restart; rolling back" >&2
	mv "$HOST_DIR" "$HOST_DIR.failed-$STAMP"
	[ -d "$BACKUP" ] && mv "$BACKUP" "$HOST_DIR"
	restart || die "rollback also failed; check the service logs"
	die "rolled back to the previous version; the failed build is in $HOST_DIR.failed-$STAMP"
fi
