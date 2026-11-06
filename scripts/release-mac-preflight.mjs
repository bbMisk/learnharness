/**
 * Publish preflight for scripts/release-mac.mjs, separate so it can be tested
 * with a fake command runner. Runs before the build; throws instead of exiting.
 * capture(command, args) → { ok, out, err }.
 */
import { createRequire } from "node:module";

const { compareVersions } = createRequire(import.meta.url)("../electron/mac-self-updater.cjs");

/** Does a git remote URL point at github.com/<repo>? (https or ssh form) */
export function isRepoURL(url, repo) {
	const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(String(url).trim());
	return !!m && m[1].toLowerCase() === repo.toLowerCase();
}

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

/** Returns the HEAD commit to release, or throws with the reason. */
export function publishPreflight(capture, { tag, repo }) {
	const status = capture("git", ["status", "--porcelain"]);
	if (!status.ok || status.out) throw new Error("working tree is not clean; commit or set aside changes first");
	const head = capture("git", ["rev-parse", "HEAD"]);
	const commit = head.out;
	if (!head.ok || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("could not resolve HEAD");
	const origin = capture("git", ["remote", "get-url", "origin"]);
	if (!origin.ok || !isRepoURL(origin.out, repo)) throw new Error(`git remote "origin" is not github.com/${repo}`);
	const branches = capture("git", ["fetch", "--quiet", "origin"]).ok ? capture("git", ["branch", "-r", "--contains", commit]) : { ok: false };
	if (!branches.ok || !/^\s*origin\//m.test(branches.out)) throw new Error(`HEAD ${commit} is not on any origin branch; push it to ${repo} first`);
	// gh release create reuses an existing tag as-is: HEAD's build must never
	// land on a tag that points at another commit.
	const tags = capture("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
	if (!tags.ok) throw new Error(`could not read tags from ${repo}`);
	const tagged = remoteTagCommit(tags.out, tag);
	if (tagged && tagged !== commit) throw new Error(`tag ${tag} on ${repo} points at ${tagged}, not HEAD ${commit}`);
	if (!capture("gh", ["auth", "status"]).ok) throw new Error("gh is not signed in (gh auth login)");
	// --latest makes this release the update feed and the permanent download.
	const latest = capture("gh", ["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"]);
	if (!latest.ok && !/HTTP 404|Not Found/i.test(`${latest.err}\n${latest.out}`)) throw new Error(`could not read the latest release of ${repo}`);
	if (latest.ok && compareVersions(tag, latest.out) <= 0) throw new Error(`${tag} is not newer than the latest release ${latest.out}; bump package.json version first`);
	return commit;
}
