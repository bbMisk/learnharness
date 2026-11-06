/**
 * macOS self-updater for unsigned (ad-hoc signed) releases — fork-owned.
 * Squirrel.Mac refuses updates that are not Developer ID signed, so builds
 * from electron-builder.unsigned-mac.yml carry `lhMacUpdater: "self"` and use
 * this instead; every other build keeps electron-updater.
 *
 * Flow: latest-mac.yml (LH_UPDATE_FEED overrides the base for drills) → newer?
 * → can this bundle be replaced? → download the ZIP → size + sha512 → ditto →
 * bundle id, version and links → "downloaded". On quit a detached shell helper
 * swaps the bundle (old one kept as a hidden sibling backup) and relaunches on
 * Restart; the new version deletes the backup on its first start.
 * Every failure is a log line plus the "error" status, never a crash.
 */
const { spawn, execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
// Electron's patched fs treats app.asar as a directory, so a recursive rm of a
// bundle stops at it. original-fs is Electron's unpatched fs; tests use node:fs.
const fs = (() => {
	try { return require("original-fs"); } catch { return require("node:fs"); }
})();
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

const DEFAULT_FEED = "https://github.com/bbMisk/learnharness/releases/latest/download/";
const FIRST_CHECK_DELAY_MS = 10 * 1000;
const CHECK_INTERVAL_HOURS = 4;
const CHECK_INTERVAL_MS = CHECK_INTERVAL_HOURS * 60 * 60 * 1000;
const DOWNLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Build-time switch: only bundles packaged with the unsigned release config
 * carry the flag. Anything else (dev, Developer ID, other OSes) → false. */
function wantsSelfUpdater(platform, packageJson) {
	return platform === "darwin" && packageJson?.lhMacUpdater === "self";
}

/* ── Versions ─────────────────────────────────────────────────────────── */

// semver ships in the app already (electron-updater's dependency, packaged by
// electron-builder.yml's file list).
const semver = require("semver");

/** -1 / 0 / 1 like a sort comparator (SemVer precedence, prereleases included). Throws on an invalid version. */
function compareVersions(a, b) {
	for (const v of [a, b]) if (!semver.valid(String(v ?? "").trim())) throw new Error(`invalid version: ${v}`);
	return semver.compare(String(a).trim(), String(b).trim());
}

/* ── Feed ───────────────────────────────────────────────────────────────── */

/** Parse electron-builder's latest-mac.yml into {version, zip: {url, sha512,
 * size}}. FAILSAFE keeps every scalar a string (a bare `1.10` must not become
 * the number 1.1). Throws a plain Error describing what is wrong. */
function parseFeed(text) {
	const yaml = require("js-yaml");
	let doc;
	try {
		doc = yaml.load(String(text), { schema: yaml.FAILSAFE_SCHEMA });
	} catch (err) {
		throw new Error(`feed is not valid YAML (${err?.reason ?? err?.message ?? err})`);
	}
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("feed is not a mapping");
	if (!semver.valid(String(doc.version ?? "").trim())) throw new Error("feed has no valid version");
	const entry = (Array.isArray(doc.files) ? doc.files : []).find((file) => typeof file?.url === "string" && /\.zip$/i.test(file.url));
	if (!entry) throw new Error("feed lists no zip");
	const size = Number(entry.size);
	if (typeof entry.sha512 !== "string" || Buffer.from(entry.sha512, "base64").length !== 64) throw new Error("feed zip has no valid sha512");
	if (!Number.isSafeInteger(size) || size <= 0) throw new Error("feed zip has no valid size");
	return { version: String(doc.version).replace(/^v/, ""), zip: { url: entry.url, sha512: entry.sha512, size } };
}

const feedBase = (override) => (override || DEFAULT_FEED).replace(/\/?$/, "/");

/* ── Download + verification ────────────────────────────────────────────── */

function run(file, args) {
	return new Promise((resolve, reject) => {
		execFile(file, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`${path.basename(file)} failed: ${String(stderr || err.message).trim()}`));
			else resolve(String(stdout));
		});
	});
}

async function fetchOk(fetchImpl, url, timeoutMs) {
	const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return res;
}

/** Stream a response body to file. pipeline() handles errors on both ends, so
 * a write failure (disk full, EISDIR) rejects here instead of becoming an
 * unhandled 'error' event that would take the app down. */
async function downloadToFile(fetchImpl, url, file) {
	const res = await fetchOk(fetchImpl, url, 30 * 60 * 1000);
	if (!res.body) throw new Error(`empty response for ${url}`);
	await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
}

/** Size first (cheap), then sha512 compared as base64 — electron-builder's form. */
async function verifyFile(file, expected) {
	const { size } = await fs.promises.stat(file);
	if (size !== expected.size) throw new Error(`size mismatch: expected ${expected.size}, got ${size}`);
	const hash = createHash("sha512");
	for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
	if (hash.digest("base64") !== expected.sha512) throw new Error("sha512 mismatch");
}

async function readPlistString(plist, key) {
	return (await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist])).trim();
}

/** Throw if any symlink inside root resolves (whole chain, via realpath) to
 * somewhere outside root, or doesn't resolve at all. Electron's frameworks
 * use relative links like Versions/Current → A, which stay inside. */
async function assertNoEscapingLinks(root) {
	const realRoot = await fs.promises.realpath(root);
	const pending = [root];
	while (pending.length) {
		const dir = pending.pop();
		for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) pending.push(full);
			if (!entry.isSymbolicLink()) continue;
			const resolved = await fs.promises.realpath(full).catch(() => null);
			if (resolved !== realRoot && !resolved?.startsWith(realRoot + path.sep)) {
				throw new Error(`the app contains a link leaving the bundle: ${path.relative(root, full)}`);
			}
		}
	}
}

/** ditto-extract the ZIP into dir and return the single .app it contains,
 * after checking it is OUR app at exactly the feed's version. */
async function extractAndVerify(zipFile, dir, { bundleId, version }) {
	await run("/usr/bin/ditto", ["-x", "-k", zipFile, dir]);
	const apps = (await fs.promises.readdir(dir)).filter((name) => name.endsWith(".app"));
	if (apps.length !== 1) throw new Error(`expected one .app in the zip, found ${apps.length}`);
	const app = path.join(dir, apps[0]);
	// lstat: a symlinked .app would pass the checks below, and the helper would
	// install only the link.
	if (!(await fs.promises.lstat(app)).isDirectory()) throw new Error("the zip's app is not a real folder");
	await assertNoEscapingLinks(app);
	const plist = path.join(app, "Contents", "Info.plist");
	const id = await readPlistString(plist, "CFBundleIdentifier");
	if (id !== bundleId) throw new Error(`bundle id mismatch: ${id}`);
	const shortVersion = await readPlistString(plist, "CFBundleShortVersionString");
	if (shortVersion !== version) throw new Error(`bundle version mismatch: ${shortVersion} (feed says ${version})`);
	return app;
}

/** Remove lh-update-* download folders older than a day (a quit mid-download,
 * a crash). Anything younger is left alone, so a copy downloading right now
 * or waiting to install keeps its folder. */
async function removeOldDownloads(tmp, { log = () => {}, now = Date.now() } = {}) {
	const names = await fs.promises.readdir(tmp).catch(() => []);
	for (const name of names.filter((n) => n.startsWith("lh-update-"))) {
		const dir = path.join(tmp, name);
		try {
			const st = await fs.promises.lstat(dir);
			if (!st.isDirectory() || now - st.mtimeMs < DOWNLOAD_MAX_AGE_MS) continue;
			await fs.promises.rm(dir, { recursive: true, force: true });
			log(`self-update: removed old download folder ${dir}`);
		} catch (err) {
			log(`self-update: could not remove ${dir}: ${err?.message ?? err}`);
		}
	}
}

/* ── Location checks ────────────────────────────────────────────────────── */

/** Why the running bundle can't be replaced in place, or null if it can.
 * "move": App Translocation or a mounted disk image (read-only, temporary);
 * "permission": a parent directory this user can't write. */
function bundleLocationProblem(bundlePath, access = fs.accessSync) {
	const resolved = path.resolve(bundlePath);
	if (resolved.includes("/AppTranslocation/") || resolved.startsWith("/Volumes/")) return "move";
	try {
		access(path.dirname(resolved), fs.constants.W_OK);
	} catch {
		return "permission";
	}
	return null;
}

/** The .app containing process.execPath (…/X.app/Contents/MacOS/X). */
const bundleFromExecPath = (execPath) => path.resolve(execPath, "..", "..", "..");

/* ── Swap helper ────────────────────────────────────────────────────────── */

/** POSIX sh, written to temp at install time (app.asar files can't run).
 * Args: PID TARGET NEW BACKUP STAGE WORKDIR RELAUNCH LOGFILE. Every mv stays
 * in TARGET's directory except the first (NEW → STAGE, which may cross
 * volumes), so the two renames that swap the app are atomic. A TERM/INT/HUP
 * (shutdown, logout) during staging or the swap puts the old app back. */
const HELPER_SCRIPT = `#!/bin/sh
# LearnHarness macOS update helper (electron/mac-self-updater.cjs).
pid=$1; target=$2; new=$3; backup=$4; stage=$5; workdir=$6; relaunch=$7; logfile=$8
log() { printf '[%s] %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$logfile" 2>/dev/null; }
launch() {
	[ "$relaunch" = 1 ] || return 0
	set -- -n
	[ -n "$LH_USER_DATA_DIR" ] && set -- "$@" --env "LH_USER_DATA_DIR=$LH_USER_DATA_DIR"
	[ -n "$LH_UPDATE_FEED" ] && set -- "$@" --env "LH_UPDATE_FEED=$LH_UPDATE_FEED"
	open "$@" "$target" || log "relaunch failed"
}
restore() {
	if [ ! -e "$target" ] && [ -e "$backup" ]; then
		if mv "$backup" "$target"; then log "previous version restored"; else log "RESTORE FAILED: previous version left at $backup"; fi
	fi
	rm -rf "$stage" "$workdir"
}

waited=0
while kill -0 "$pid" 2>/dev/null; do
	if [ "$waited" -ge 1200 ]; then log "app still running after 120 s; update not installed"; rm -rf "$workdir"; exit 1; fi
	sleep 0.1
	waited=$((waited + 1))
done
log "installing $new over $target"
trap 'log "interrupted"; restore; exit 1' TERM INT HUP
if ! mv "$new" "$stage" || ! mv "$target" "$backup" || [ -e "$target" ] || ! mv "$stage" "$target"; then
	trap - TERM INT HUP
	log "install failed; keeping the previous version"
	restore
	launch
	exit 1
fi
trap - TERM INT HUP
xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
rm -rf "$workdir"
log "installed; previous version kept at $backup until the new version starts"
launch
exit 0
`;

function backupPaths(target, stamp = Date.now()) {
	const dir = path.dirname(target);
	const name = path.basename(target);
	// No .app suffix: Finder/LaunchServices treat these as plain folders.
	return { backup: path.join(dir, `.${name}.update-backup-${stamp}`), stage: path.join(dir, `.${name}.update-new-${stamp}`) };
}

function isOwnBackup(target, backup) {
	return typeof backup === "string"
		&& path.dirname(backup) === path.dirname(target)
		&& path.basename(backup).startsWith(`.${path.basename(target)}.update-backup-`);
}

/** Spawn the helper detached so it outlives this process. */
function spawnHelper({ workdir, pid, target, newApp, backup, stage, relaunch, logFile, env = process.env, spawnImpl = spawn, searchPath = "/usr/bin:/bin:/usr/sbin:/sbin" }) {
	const script = path.join(workdir, "install-update.sh");
	fs.writeFileSync(script, HELPER_SCRIPT, { mode: 0o700 });
	// A fixed PATH: the helper must not pick up tools from the user's shell setup.
	const childEnv = { PATH: searchPath };
	// Carry the test seams across the relaunch so a drill never reaches real data.
	for (const key of ["LH_USER_DATA_DIR", "LH_UPDATE_FEED"]) if (env[key]) childEnv[key] = env[key];
	const child = spawnImpl("/bin/sh", [script, String(pid), target, newApp, backup, stage, workdir, relaunch ? "1" : "0", logFile], {
		detached: true,
		stdio: "ignore",
		env: childEnv,
	});
	child.unref?.();
	return child;
}

/* ── After an install ───────────────────────────────────────────────────── */

/** One marker per installation path, so copies sharing a userData folder
 * never read or delete each other's marker. */
function markerPath(userData, bundlePath) {
	const key = createHash("sha256").update(path.resolve(bundlePath)).digest("hex").slice(0, 16);
	return path.join(userData, `self-update-${key}.json`);
}

/** On start: settle a previous run's install. Returns "none" (no marker),
 * "ignored" (unrecognized marker, removed), "cleaned" (the new version runs:
 * backup + marker removed), "cleanup-failed" (marker kept, retried next start),
 * "pending" (another version runs but the swap's backup exists: marker kept for
 * the new version) or "not-updated" (no swap happened or it rolled back). */
async function finishPendingUpdate({ markerFile, bundlePath, version, log = () => {} }) {
	let marker;
	try {
		marker = JSON.parse(await fs.promises.readFile(markerFile, "utf8"));
	} catch (err) {
		if (err?.code === "ENOENT") return "none";
	}
	const clear = () => fs.promises.rm(markerFile, { force: true }).catch(() => {});
	if (!marker || marker.target !== bundlePath || !isOwnBackup(bundlePath, marker.backup)) {
		log("self-update: ignoring an unrecognized update marker");
		await clear();
		return "ignored";
	}
	if (marker.version === version) {
		try {
			await fs.promises.rm(marker.backup, { recursive: true, force: true });
		} catch (err) {
			log(`self-update: could not remove backup ${marker.backup} (will retry next start): ${err?.message ?? err}`);
			return "cleanup-failed";
		}
		log(`self-update: now running ${version}; removed the previous version's backup`);
		await clear();
		return "cleaned";
	}
	if (fs.existsSync(marker.backup)) return "pending";
	log(`self-update: update to ${marker.version} did not complete; running ${version}`);
	await clear();
	return "not-updated";
}

/* ── The updater ────────────────────────────────────────────────────────── */

/**
 * deps: { app, log, report(status, version), env, execPath, fetchImpl,
 *         bundleId, tmpdir, spawnImpl }
 * report() receives the existing statuses plus "move-to-applications" and
 * "manual-download" (the bundle can't be replaced in place).
 */
function createMacSelfUpdater(deps) {
	const { app, log, report } = deps;
	const env = deps.env ?? process.env;
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const tmpdir = deps.tmpdir ?? os.tmpdir();
	const bundlePath = bundleFromExecPath(deps.execPath ?? process.execPath);
	const base = feedBase(env.LH_UPDATE_FEED);
	const markerFile = markerPath(app.getPath("userData"), bundlePath);
	const logFile = path.join(app.getPath("userData"), "logs", "update-helper.log");
	let inFlight = null;
	let staged = null; // { version, app, workdir }
	let relaunchOnQuit = false;
	let swapStarted = false;

	if (env.LH_UPDATE_FEED) log(`self-update: LH_UPDATE_FEED override → ${base}`);
	const startup = Promise.all([
		finishPendingUpdate({ markerFile, bundlePath, version: app.getVersion(), log }),
		removeOldDownloads(tmpdir, { log }),
	]).catch((err) => log(`self-update: startup cleanup failed: ${err?.message ?? err}`));

	async function runCheck() {
		report("checking");
		const feed = parseFeed(await (await fetchOk(fetchImpl, `${base}latest-mac.yml`, 30 * 1000)).text());
		const current = app.getVersion();
		if (compareVersions(feed.version, current) <= 0) {
			log(`self-update: ${current} is current (feed: ${feed.version})`);
			report("up-to-date");
			return;
		}
		const problem = bundleLocationProblem(bundlePath);
		if (problem) {
			log(`self-update: ${feed.version} available but ${bundlePath} can't be replaced (${problem})`);
			report(problem === "move" ? "move-to-applications" : "manual-download", feed.version);
			return;
		}
		report("downloading", feed.version);
		const workdir = await fs.promises.mkdtemp(path.join(tmpdir, "lh-update-"));
		try {
			const zipFile = path.join(workdir, "update.zip");
			await downloadToFile(fetchImpl, new URL(feed.zip.url, base).href, zipFile);
			await verifyFile(zipFile, feed.zip);
			const extractDir = path.join(workdir, "extracted");
			await fs.promises.mkdir(extractDir);
			const bundleId = deps.bundleId ?? await readPlistString(path.join(bundlePath, "Contents", "Info.plist"), "CFBundleIdentifier");
			const newApp = await extractAndVerify(zipFile, extractDir, { bundleId, version: feed.version });
			await fs.promises.rm(zipFile, { force: true });
			staged = { version: feed.version, app: newApp, workdir };
			log(`self-update: ${feed.version} downloaded and verified — ready to install`);
			report("downloaded", feed.version);
		} catch (err) {
			await fs.promises.rm(workdir, { recursive: true, force: true }).catch(() => {});
			throw err;
		}
	}

	/** Never rejects. A staged update short-circuits further checks. */
	function check() {
		if (staged) {
			report("downloaded", staged.version);
			return Promise.resolve();
		}
		inFlight ??= runCheck()
			.catch((err) => {
				log(`self-update failed: ${err?.message ?? err}`);
				report("error");
			})
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	}

	/** Start the detached swap. Called from will-quit; runs at most once. */
	function startSwap() {
		if (!staged || swapStarted) return false;
		swapStarted = true;
		try {
			const { backup, stage } = backupPaths(bundlePath);
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			fs.writeFileSync(markerFile, JSON.stringify({ version: staged.version, from: app.getVersion(), target: bundlePath, backup }, null, 2));
			const child = spawnHelper({ workdir: staged.workdir, pid: process.pid, target: bundlePath, newApp: staged.app, backup, stage, relaunch: relaunchOnQuit, logFile, env, spawnImpl: deps.spawnImpl });
			// A failed spawn reports asynchronously; without a listener it would crash the quitting app.
			child?.on?.("error", (err) => {
				log(`self-update: the installer did not start: ${err?.message ?? err}`);
				try { fs.rmSync(markerFile, { force: true }); } catch { /* settled as not-updated next start */ }
			});
			log(`self-update: installing ${staged.version} after quit (relaunch: ${relaunchOnQuit})`);
			return true;
		} catch (err) {
			log(`self-update: could not start the installer: ${err?.message ?? err}`);
			return false;
		}
	}

	/** "Restart to update" (main.cjs stops the server first); will-quit swaps. */
	function installNow() {
		if (!staged) return;
		relaunchOnQuit = true;
		app.quit();
	}

	return { check, installNow, startSwap, startup, get staged() { return staged; } };
}

module.exports = {
	FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_HOURS, CHECK_INTERVAL_MS, wantsSelfUpdater, compareVersions, parseFeed, feedBase,
	verifyFile, assertNoEscapingLinks, removeOldDownloads, bundleLocationProblem, bundleFromExecPath, backupPaths,
	isOwnBackup, spawnHelper, markerPath, finishPendingUpdate, createMacSelfUpdater,
};
