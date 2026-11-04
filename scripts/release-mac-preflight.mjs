/**
 * Publish preflight for scripts/release-mac.mjs, separate so it can be tested
 * with a fake command runner. Runs before the build; throws instead of exiting.
 * capture(command, args) → { ok, out }.
 */

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
	if (capture("gh", ["release", "view", tag, "--repo", repo]).ok) throw new Error(`release ${tag} already exists on ${repo}; bump package.json version first`);
	return commit;
}
