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

export function publishPreflight(capture, { tag, repo }) {
	if (capture("git", ["status", "--porcelain"]).out) throw new Error("working tree is not clean; commit or set aside changes first");
	const commit = capture("git", ["rev-parse", "HEAD"]).out;
	if (!capture("git", ["branch", "-r", "--contains", commit]).out) throw new Error(`HEAD ${commit} is not on any remote branch; push it first`);
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
