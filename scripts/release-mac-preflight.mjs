/**
 * Publish preflight for scripts/release-mac.mjs, separate so it can be tested
 * with a fake command runner. Runs before the build; throws instead of exiting.
 * capture(command, args) → { ok, out }.
 */
import { createRequire } from "node:module";

const { compareVersions } = createRequire(import.meta.url)("../electron/mac-self-updater.cjs");

/** The commit a remote tag points at, from `git ls-remote` output (the peeled
 * `^{}` line wins for annotated tags), or null when the tag doesn't exist. */
export function remoteTagCommit(lsRemoteOutput, tag) {
	let plain = null;
	for (const line of String(lsRemoteOutput).split("\n")) {
		const [sha, ref] = line.trim().split(/\s+/);
		if (ref === `refs/tags/${tag}^{}`) return sha;
		if (ref === `refs/tags/${tag}`) plain = sha;
	}
	return plain;
}

/** Does a git remote URL point at github.com/<repo>? (https, scp-style ssh or
 * ssh:// form). The host must be exactly github.com (round-3 hunt finding). */
export function isRepoURL(url, repo) {
	const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(String(url).trim());
	return !!m && m[1].toLowerCase() === repo.toLowerCase();
}

/** Remote-tracking branches of `remote` in `git branch -r` output (skips the
 * symbolic "origin/HEAD -> origin/main" line). */
export function remoteBranches(output, remote) {
	return String(output).split("\n").map((l) => l.trim().replace(/^\* /, ""))
		.filter((l) => l.startsWith(`${remote}/`) && !l.includes(" -> ") && /^[^\s]+$/.test(l));
}

/** Refuse when the current latest release is not older than this one (round-8
 * hunt finding: `--latest` would make an older build the permanent download and
 * the update feed), or carries Windows/Linux feeds. */
function checkLatestRelease(capture, repo, tag) {
	const latest = capture("gh", ["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name, .assets[].name"]);
	if (!latest.ok && !/HTTP 404|Not Found/i.test(`${latest.err}\n${latest.out}`)) throw new Error(`could not read the current latest release of ${repo}`);
	if (!latest.ok) return; // no latest release yet
	const [latestTag = ""] = latest.out.split("\n");
	let newer;
	try { newer = compareVersions(tag, latestTag.trim()) > 0; } catch { throw new Error(`could not compare ${tag} with the latest release tag "${latestTag.trim()}"`); }
	if (!newer) throw new Error(`${tag} is not newer than the latest release ${latestTag.trim()}; bump package.json version first`);
	if (/^latest(-linux)?\.yml$/m.test(latest.out)) throw new Error("the current latest release serves Windows/Linux updates (latest.yml / latest-linux.yml); a macOS-only release marked latest would break them. Ship those platforms' assets in this release too.");
}

export function publishPreflight(capture, { tag, repo }) {
	// Every check requires success: a failed command's empty or error output is never evidence.
	const status = capture("git", ["status", "--porcelain"]);
	if (!status.ok) throw new Error("could not read git status");
	if (status.out) throw new Error("working tree is not clean; commit or set aside changes first");
	const head = capture("git", ["rev-parse", "HEAD"]);
	const commit = head.out;
	if (!head.ok || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("could not resolve HEAD");
	const origin = capture("git", ["remote", "get-url", "origin"]);
	if (!origin.ok || !isRepoURL(origin.out, repo)) throw new Error(`git remote "origin" is not github.com/${repo}`);
	// The tag is pushed to origin: its push URL must be the release repo too (round-6 hunt finding).
	const pushURL = capture("git", ["remote", "get-url", "--push", "origin"]);
	if (!pushURL.ok || !isRepoURL(pushURL.out, repo)) throw new Error(`git remote "origin" pushes somewhere other than github.com/${repo}`);
	// Refresh origin's branches first: a stale tracking ref of a deleted or
	// force-pushed branch is not evidence that GitHub has HEAD (round-3 hunt finding).
	if (!capture("git", ["fetch", "--prune", "--quiet", "origin"]).ok) throw new Error("could not fetch origin to confirm HEAD is pushed");
	const branches = capture("git", ["branch", "-r", "--contains", commit]);
	if (!branches.ok || remoteBranches(branches.out, "origin").length === 0) throw new Error(`HEAD ${commit} is not on any origin branch; push it to ${repo} first`);
	// gh release create reuses an existing tag as-is: artifacts built from HEAD
	// must never land on a tag that points at another commit.
	const tags = capture("git", ["ls-remote", "--tags", `https://github.com/${repo}.git`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
	if (!tags.ok) throw new Error(`could not read tags from ${repo}`);
	const tagged = remoteTagCommit(tags.out, tag);
	if (tagged && tagged !== commit) throw new Error(`tag ${tag} on ${repo} points at ${tagged}, not HEAD ${commit}; refusing to upload HEAD's build under it`);
	if (!capture("gh", ["auth", "status"]).ok) throw new Error("gh is not signed in (gh auth login)");
	// This release becomes "latest" for every platform. Windows/Linux copies
	// follow latest.yml / latest-linux.yml in the latest release; a macOS-only
	// one would break their update checks (round-5 hunt finding). None exist
	// yet; refuse once they do, until their assets ship in the same release.
	checkLatestRelease(capture, repo, tag);
	if (capture("gh", ["release", "view", tag, "--repo", repo]).ok) throw new Error(`release ${tag} already exists on ${repo}; bump package.json version first`);
	return commit;
}

/** Pin the release tag to the built commit right before `gh release create`
 * (round-4 hunt finding: the tag could be created or moved during the build).
 * A plain push creates the tag, is a no-op when it already points at commit,
 * and is rejected when it points elsewhere; never forced. The release is then
 * created with --verify-tag, so gh uses exactly this tag. */
export function pinReleaseTag(capture, { tag, commit, repo }) {
	if (!/^[0-9a-f]{40}$/.test(String(commit))) throw new Error("no commit to tag");
	const pushed = capture("git", ["push", "origin", `${commit}:refs/tags/${tag}`]);
	if (!pushed.ok) throw new Error(`could not pin tag ${tag} to ${commit} on origin (it may point at another commit): ${pushed.err || pushed.out}`);
	// Then read the tag back from the release repo itself, and re-check that
	// the latest release is still macOS-only (round-6 hunt finding): the last
	// checks before gh release create, not the ones from before the build.
	const tags = capture("git", ["ls-remote", "--tags", `https://github.com/${repo}.git`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
	const tagged = tags.ok ? remoteTagCommit(tags.out, tag) : null;
	if (tagged !== commit) throw new Error(`tag ${tag} on ${repo} points at ${tagged ?? "nothing"}, not the built commit ${commit}; not publishing`);
	checkLatestRelease(capture, repo, tag);
}
