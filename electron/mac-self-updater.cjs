/**
 * macOS self-updater (owner design, 2026-11-03) — fork-owned.
 *
 * Why: Squirrel.Mac (electron-updater's macOS path) refuses updates that are
 * not Developer ID signed, and unsigned releases are ad-hoc signed. So on
 * macOS, builds made by scripts/release-mac.mjs carry `lhMacUpdater: "self"`
 * in their packaged package.json (electron-builder.unsigned-mac.yml
 * extraMetadata) and use this updater instead. Builds without that flag —
 * a future Developer ID build, Windows, Linux — keep electron-updater.
 *
 * Flow: read electron-builder's latest-mac.yml from the latest GitHub release
 * (LH_UPDATE_FEED overrides the base URL for local drills) → newer version? →
 * check the running bundle can be replaced → download the ZIP to a temp dir →
 * verify size + sha512 → ditto-extract → verify bundle id + version →
 * "downloaded". Restart (or a normal quit) runs a detached shell helper that
 * waits for this process to exit, swaps the bundle (old one kept as a hidden
 * sibling backup), and relaunches. The new version deletes the backup on its
 * first start (keep-old-until-new-launches), via a marker in userData.
 *
 * Hard rule: nothing here can take the app down. Every failure is a log line
 * plus the generic "error" status; nothing is installed and temp is cleaned.
 */
const { spawn, execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
// Electron's patched fs treats app.asar as a directory, so a recursive rm of
// a bundle stops at it (ENOTEMPTY, seen in the 2026-11-03 drill). original-fs
// is the unpatched module inside Electron; plain Node (tests) has no such module.
const fs = (() => {
	try {
		return require("original-fs");
	} catch {
		return require("node:fs");
	}
})();
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

const DEFAULT_FEED = "https://github.com/bbMisk/learnharness/releases/latest/download/";
const MANUAL_DOWNLOAD_URL = "https://github.com/bbMisk/learnharness/releases/latest/download/LearnHarness-arm64.dmg";
const FIRST_CHECK_DELAY_MS = 10 * 1000;
const CHECK_INTERVAL_HOURS = 4;
const CHECK_INTERVAL_MS = CHECK_INTERVAL_HOURS * 60 * 60 * 1000;
/** One marker per installation path: copies sharing a userData folder
 * (e.g. two install locations) never read or delete each other's marker. */
function markerPath(userData, bundlePath) {
	const key = createHash("sha256").update(path.resolve(bundlePath)).digest("hex").slice(0, 16);
	return path.join(userData, `self-update-${key}.json`);
}

/** Build-time switch: only bundles packaged with the unsigned release config
 * carry the flag. Anything else (dev, Developer ID, other OSes) → false. */
function wantsSelfUpdater(platform, packageJson) {
	return platform === "darwin" && packageJson?.lhMacUpdater === "self";
}

/* ── Versions (SemVer 2.0 precedence, prereleases included) ─────────────── */

function parseVersion(value) {
	const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? "").trim());
	if (!m) return null;
	return { core: [BigInt(m[1]), BigInt(m[2]), BigInt(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** -1 / 0 / 1 like a sort comparator. Throws on an invalid version. */
function compareVersions(a, b) {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) throw new Error(`invalid version: ${!x ? a : b}`);
	for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
	// A release outranks any of its prereleases.
	if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		if (p === q) continue;
		const pn = /^\d+$/.test(p);
		const qn = /^\d+$/.test(q);
		// BigInt: identifiers past 2^53 must not round together (round-3 hunt finding).
		if (pn && qn) { const d = BigInt(p) - BigInt(q); if (d !== 0n) return d < 0n ? -1 : 1; continue; }
		if (pn !== qn) return pn ? -1 : 1; // numeric identifiers sort first
		return p < q ? -1 : 1;
	}
	return 0;
}

/* ── Feed ───────────────────────────────────────────────────────────────── */

/** Parse electron-builder's latest-mac.yml. FAILSAFE keeps every scalar a
 * string (a bare `1.10` must not become the number 1.1). Returns
 * {version, files, zip}; throws a plain Error describing what is wrong. */
function parseFeed(text) {
	const yaml = require("js-yaml");
	let doc;
	try {
		doc = yaml.load(String(text), { schema: yaml.FAILSAFE_SCHEMA });
	} catch (err) {
		throw new Error(`feed is not valid YAML (${err?.reason ?? err?.message ?? err})`);
	}
	if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("feed is not a mapping");
	if (!parseVersion(doc.version)) throw new Error("feed has no valid version");
	if (!Array.isArray(doc.files) || doc.files.length === 0) throw new Error("feed lists no files");
	const files = doc.files.map((entry, i) => {
		if (!entry || typeof entry !== "object") throw new Error(`feed file ${i} is not a mapping`);
		const { url, sha512 } = entry;
		const size = Number(entry.size);
		if (typeof url !== "string" || !url) throw new Error(`feed file ${i} has no url`);
		if (typeof sha512 !== "string" || Buffer.from(sha512, "base64").length !== 64) throw new Error(`feed file ${i} has no valid sha512`);
		if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`feed file ${i} has no valid size`);
		return { url, sha512, size };
	});
	const zip = files.find((file) => /\.zip$/i.test(new URL(file.url, "https://feed.invalid/").pathname));
	if (!zip) throw new Error("feed lists no zip");
	return { version: String(doc.version).replace(/^v/, ""), files, zip };
}

function feedBase(override) {
	const base = override || DEFAULT_FEED;
	return base.endsWith("/") ? base : `${base}/`;
}

function resolveFileURL(base, fileUrl) {
	const url = new URL(fileUrl, base);
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`refusing feed file URL ${url.protocol}`);
	return url.href;
}

/* ── Verification ───────────────────────────────────────────────────────── */

/** Size first (cheap), then sha512 compared as base64 — electron-builder's form. */
async function verifyFile(file, expected) {
	const { size } = await fs.promises.stat(file);
	if (size !== expected.size) throw new Error(`size mismatch: expected ${expected.size}, got ${size}`);
	const hash = createHash("sha512");
	for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
	const actual = hash.digest("base64");
	if (actual !== expected.sha512) throw new Error("sha512 mismatch");
}

/** Why the running bundle can't be replaced in place, or null if it can.
 * "move": App Translocation or a mounted disk image (read-only, temporary);
 * "permission": a parent directory this user can't write. */
function bundleLocationProblem(bundlePath, access = fs.accessSync) {
	const resolved = path.resolve(bundlePath);
	if (resolved.includes("/AppTranslocation/")) return "move";
	if (resolved.startsWith("/Volumes/")) return "move";
	try {
		access(path.dirname(resolved), fs.constants.W_OK);
	} catch {
		return "permission";
	}
	return null;
}

/** The .app containing process.execPath (…/X.app/Contents/MacOS/X). */
function bundleFromExecPath(execPath) {
	return path.resolve(execPath, "..", "..", "..");
}

function run(file, args) {
	return new Promise((resolve, reject) => {
		execFile(file, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`${path.basename(file)} failed: ${String(stderr || err.message).trim()}`));
			else resolve(String(stdout));
		});
	});
}

async function fetchOk(fetchImpl, url, timeoutMs, signal) {
	const timeout = AbortSignal.timeout(timeoutMs);
	const res = await fetchImpl(url, { redirect: "follow", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return res;
}

/** Stream a response body to file. pipeline() attaches error handlers to
 * both ends up front, so a write failure (disk full, EISDIR) rejects here —
 * never an unhandled 'error' event that would take the app down. */
async function downloadToFile(fetchImpl, url, file, signal) {
	const res = await fetchOk(fetchImpl, url, 30 * 60 * 1000, signal);
	if (!res.body) throw new Error(`empty response for ${url}`);
	await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file), ...(signal ? [{ signal }] : []));
}

const OWNER_FILE = "owner.pid";

/** Remove lh-update-* download folders left by a process that is gone (a
 * quit mid-download, a crash). Each folder names its owner PID; folders of a
 * live process — another copy downloading right now — are left alone.
 * The owner file lists every PID that still needs the folder (the app, then
 * also its install helper once quitting); it is abandoned only when ALL are
 * gone (round-3 hunt finding: a quit app's helper was losing its staged copy).
 * A folder holding an install script younger than the install window is kept
 * whatever its owner file says: the helper may be running before its PID was
 * recorded (round-4 hunt finding).
 * Folders without an owner file are only reclaimed after a day. */
async function reclaimAbandonedDownloads(tmp, { log = () => {}, isAlive = processAlive, now = Date.now() } = {}) {
	let names;
	try {
		names = await fs.promises.readdir(tmp);
	} catch {
		return [];
	}
	const removed = [];
	for (const name of names.filter((n) => n.startsWith("lh-update-"))) {
		const dir = path.join(tmp, name);
		try {
			const st = await fs.promises.lstat(dir);
			if (!st.isDirectory()) continue;
			let owners = [];
			try { owners = (await fs.promises.readFile(path.join(dir, OWNER_FILE), "utf8")).trim().split(/\s+/).map(Number); } catch { /* none */ }
			const valid = owners.length > 0 && owners.every((pid) => Number.isInteger(pid) && pid > 0);
			const abandoned = valid ? owners.every((pid) => !isAlive(pid)) : now - st.mtimeMs > 24 * 60 * 60 * 1000;
			if (!abandoned) continue;
			const script = await fs.promises.lstat(path.join(dir, "install-update.sh")).catch(() => null);
			if (script && now - script.mtimeMs < INSTALL_WINDOW_MS) continue;
			await fs.promises.rm(dir, { recursive: true, force: true });
			removed.push(dir);
		} catch (err) {
			log(`self-update: could not reclaim ${dir}: ${err?.message ?? err}`);
		}
	}
	if (removed.length) log(`self-update: removed ${removed.length} abandoned download folder(s)`);
	return removed;
}

async function readPlistString(plist, key) {
	return (await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist])).trim();
}

/** ditto-extract the ZIP into dir and return the single .app it contains,
 * after checking it is OUR app at exactly the feed's version. */
async function extractAndVerify(zipFile, dir, { bundleId, version }) {
	await run("/usr/bin/ditto", ["-x", "-k", zipFile, dir]);
	const apps = (await fs.promises.readdir(dir)).filter((name) => name.endsWith(".app"));
	if (apps.length !== 1) throw new Error(`expected one .app in the zip, found ${apps.length}`);
	const app = path.join(dir, apps[0]);
	// lstat, not stat: a symlinked .app would pass the plist checks below, and
	// the helper would install only the link and delete what it points to.
	if (!(await fs.promises.lstat(app)).isDirectory()) throw new Error("the zip's app is not a real folder");
	await assertNoEscapingLinks(app);
	const plist = path.join(app, "Contents", "Info.plist");
	const id = await readPlistString(plist, "CFBundleIdentifier");
	if (id !== bundleId) throw new Error(`bundle id mismatch: ${id}`);
	const shortVersion = await readPlistString(plist, "CFBundleShortVersionString");
	if (shortVersion !== version) throw new Error(`bundle version mismatch: ${shortVersion} (feed says ${version})`);
	return app;
}

/** Throw if any symlink inside root is absolute, dangling, loops, or — after
 * the filesystem resolves the whole chain — lands outside the real bundle
 * root. (A lexical check is not enough: b/c → .., a → b/c, x → a/../out
 * looks inside but resolves outside.) Electron's frameworks use relative
 * links like Versions/Current → A, which resolve inside. */
async function assertNoEscapingLinks(root) {
	const realRoot = await fs.promises.realpath(root);
	const pending = [root];
	while (pending.length) {
		const dir = pending.pop();
		for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				const target = await fs.promises.readlink(full);
				const where = path.relative(root, full);
				if (path.isAbsolute(target)) throw new Error(`the app contains an absolute link: ${where} → ${target}`);
				let resolved;
				try {
					resolved = await fs.promises.realpath(full);
				} catch (err) {
					throw new Error(`the app contains a broken link: ${where} → ${target} (${err?.code ?? err})`);
				}
				if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
					throw new Error(`the app contains a link leaving the bundle: ${where} → ${target}`);
				}
			} else if (entry.isDirectory()) {
				pending.push(full);
			}
		}
	}
}

/* ── Swap helper ────────────────────────────────────────────────────────── */

/** POSIX sh, written to temp at install time (app.asar files can't run).
 * Args: PID TARGET NEW BACKUP STAGE WORKDIR RELAUNCH LOGFILE. Every mv stays
 * in TARGET's directory except the first (NEW → STAGE, which may cross
 * volumes), so the two renames that swap the app are atomic. */
const HELPER_SCRIPT = `#!/bin/sh
# LearnHarness macOS update helper (electron/mac-self-updater.cjs).
pid=$1; target=$2; new=$3; backup=$4; stage=$5; workdir=$6; relaunch=$7; logfile=$8
log() { printf '[%s] %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$logfile" 2>/dev/null; }
launch() {
	[ "$relaunch" = 1 ] || return 0
	app=$1
	set -- -n
	[ -n "$LH_USER_DATA_DIR" ] && set -- "$@" --env "LH_USER_DATA_DIR=$LH_USER_DATA_DIR"
	[ -n "$LH_UPDATE_FEED" ] && set -- "$@" --env "LH_UPDATE_FEED=$LH_UPDATE_FEED"
	open "$@" "$app" || log "relaunch failed"
}
fail() { log "$1"; rm -rf "$stage" "$workdir"; launch "$target"; exit 1; }

waited=0
while kill -0 "$pid" 2>/dev/null; do
	if [ "$waited" -ge 1200 ]; then log "app still running after 120 s; update not installed"; rm -rf "$workdir"; exit 1; fi
	sleep 0.1
	waited=$((waited + 1))
done
log "installing $new over $target"
mv "$new" "$stage" || fail "could not stage the new version; nothing changed"
mv "$target" "$backup" || fail "could not move the current version aside; nothing changed"
if [ -e "$target" ] || ! mv "$stage" "$target"; then
	log "could not move the new version into place; restoring the previous version"
	if [ ! -e "$target" ] && mv "$backup" "$target"; then log "previous version restored"; else log "RESTORE FAILED: previous version left at $backup"; fi
	rm -rf "$stage" "$workdir"
	launch "$target"
	exit 1
fi
xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
rm -rf "$workdir"
log "installed; previous version kept at $backup until the new version starts"
launch "$target"
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

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

const INSTALL_WINDOW_MS = 10 * 60 * 1000; // helper wait (120 s) + swap, with margin against PID reuse

/** Is a previous run's install still in progress? The helper is running, or
 * the quitting app that wrote the marker is still alive and about to start it
 * (no helper PID recorded yet). Only within the install window, against PID reuse. */
function installRunning(marker, isAlive = processAlive, now = Date.now()) {
	if (!marker || now - Number(marker.startedAt) >= INSTALL_WINDOW_MS) return false;
	if (Number.isInteger(marker.helperPid)) return isAlive(marker.helperPid);
	return Number.isInteger(marker.appPid) && marker.appPid > 0 && isAlive(marker.appPid);
}

async function bundleVersion(bundlePath) {
	return readPlistString(path.join(bundlePath, "Contents", "Info.plist"), "CFBundleShortVersionString");
}

/** On start: settle a previous run's install. Returns
 *  "none"        no marker;
 *  "ignored"     unrecognized marker (removed, nothing deleted);
 *  "cleaned"     the NEW version is running: backup + marker removed;
 *  "installing"  the helper is still running: marker kept, nothing touched;
 *  "stale"       an OLD process started while the swap ran and the bundle on
 *                disk is already the new version: marker kept for the new one;
 *  "not-updated" the install never happened or rolled back: marker removed. */
async function finishPendingUpdate({ markerFile, bundlePath, version, log = () => {}, readVersion = bundleVersion, isAlive = processAlive, now = Date.now() }) {
	let marker;
	let raw = null;
	try {
		raw = await fs.promises.readFile(markerFile, "utf8");
		marker = JSON.parse(raw);
	} catch (err) {
		if (err?.code === "ENOENT") return "none";
		marker = null;
	}
	const clear = () => fs.promises.rm(markerFile, { force: true }).catch(() => {});
	if (!marker || typeof marker !== "object" || marker.target !== bundlePath || !isOwnBackup(bundlePath, marker.backup)) {
		log("self-update: ignoring an unrecognized update marker");
		await clear();
		return "ignored";
	}
	if (marker.version === version) {
		try {
			await fs.promises.rm(marker.backup, { recursive: true, force: true });
		} catch (err) {
			// Keep the marker: a later launch retries instead of orphaning the backup.
			log(`self-update: could not remove backup ${marker.backup} (will retry next launch): ${err?.message ?? err}`);
			return "cleanup-failed";
		}
		log(`self-update: now running ${version}; removed the previous version's backup`);
		await clear();
		return "cleaned";
	}
	if (installRunning(marker, isAlive, now)) {
		log(`self-update: an install of ${marker.version} is still running`);
		return "installing";
	}
	const onDisk = await readVersion(bundlePath).catch(() => null);
	if (onDisk === marker.version) {
		log(`self-update: ${marker.version} is installed but this process is ${version}; keeping the marker for the new version`);
		return "stale";
	}
	// Only clear the marker this launch judged: a quitting app may have just
	// rewritten it with its helper's PID (round-4 hunt finding).
	const current = await fs.promises.readFile(markerFile, "utf8").catch(() => null);
	if (current !== raw) {
		log("self-update: the update marker changed while settling; leaving it");
		return "installing";
	}
	log(`self-update: update to ${marker.version} did not complete; running ${version}`);
	await clear();
	return "not-updated";
}

const AFTER_INSTALL_ARG = "--lh-after-install";

/** First thing on launch (before the server starts). If an install is still
 * running, or already replaced this bundle while this OLD process started,
 * step aside: release the single-instance lock, wait for the helper, and
 * relaunch the bundle path — which now holds the installed version (or the
 * restored one). Returns true when this process is exiting. One relaunch at
 * most (AFTER_INSTALL_ARG), so a broken state can never loop. */
async function yieldToPendingInstall({ app, log = () => {}, execPath = process.execPath, argv = process.argv, readVersion, isAlive = processAlive, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 150 * 1000 }) {
	const bundlePath = bundleFromExecPath(execPath);
	const markerFile = markerPath(app.getPath("userData"), bundlePath);
	const settle = () => finishPendingUpdate({ markerFile, bundlePath, version: app.getVersion(), log, readVersion, isAlive });
	let state = await settle();
	if ((state !== "installing" && state !== "stale") || argv.includes(AFTER_INSTALL_ARG)) return false;
	try { app.releaseSingleInstanceLock?.(); } catch { /* not held */ }
	for (let waited = 0; state === "installing" && waited < timeoutMs; waited += 200) {
		// Re-read each time: the helper's PID lands in the marker after spawn.
		let marker = null;
		try { marker = JSON.parse(await fs.promises.readFile(markerFile, "utf8")); } catch { /* gone */ }
		if (!installRunning(marker, isAlive)) break;
		await sleep(200);
	}
	log("self-update: relaunching into the installed version");
	app.relaunch({ args: [...argv.slice(1).filter((a) => a !== AFTER_INSTALL_ARG), AFTER_INSTALL_ARG] });
	app.exit(0);
	return true;
}

/* ── The updater ────────────────────────────────────────────────────────── */

/**
 * deps: { app, log, report(status, version), killServer, env, execPath,
 *         fetchImpl, bundleId, tmpdir, spawnImpl }
 * report() receives the existing statuses plus "move-to-applications" and
 * "manual-download" (the bundle can't be replaced in place).
 */
function createMacSelfUpdater(deps) {
	const { app, log, report, killServer = () => {} } = deps;
	const env = deps.env ?? process.env;
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const bundlePath = bundleFromExecPath(deps.execPath ?? process.execPath);
	const base = feedBase(env.LH_UPDATE_FEED);
	const markerFile = markerPath(app.getPath("userData"), bundlePath);
	const logFile = path.join(app.getPath("userData"), "logs", "update-helper.log");
	let inFlight = null;
	let download = null; // { workdir, abort } while a download runs
	let staged = null; // { version, app, workdir }
	let relaunchOnQuit = false;
	let swapStarted = false;

	const tmpdir = deps.tmpdir ?? os.tmpdir();
	if (env.LH_UPDATE_FEED) log(`self-update: LH_UPDATE_FEED override → ${base}`);
	void reclaimAbandonedDownloads(tmpdir, { log });

	async function bundleId() {
		if (deps.bundleId) return deps.bundleId;
		return readPlistString(path.join(bundlePath, "Contents", "Info.plist"), "CFBundleIdentifier");
	}

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
		const controller = new AbortController();
		download = { workdir, abort: () => controller.abort() };
		try {
			await fs.promises.writeFile(path.join(workdir, OWNER_FILE), String(process.pid));
			const zipFile = path.join(workdir, "update.zip");
			await downloadToFile(fetchImpl, resolveFileURL(base, feed.zip.url), zipFile, controller.signal);
			await verifyFile(zipFile, feed.zip);
			const extractDir = path.join(workdir, "extracted");
			await fs.promises.mkdir(extractDir);
			const newApp = await extractAndVerify(zipFile, extractDir, { bundleId: await bundleId(), version: feed.version });
			await fs.promises.rm(zipFile, { force: true });
			staged = { version: feed.version, app: newApp, workdir };
			log(`self-update: ${feed.version} downloaded and verified — ready to install`);
			report("downloaded", feed.version);
		} catch (err) {
			await fs.promises.rm(workdir, { recursive: true, force: true }).catch(() => {});
			throw err;
		} finally {
			download = null;
		}
	}

	/** Never rejects. A staged update short-circuits further checks. */
	function check() {
		if (staged) {
			report("downloaded", staged.version);
			return Promise.resolve();
		}
		if (inFlight) return inFlight;
		inFlight = runCheck()
			.catch((err) => {
				log(`self-update failed: ${err?.message ?? err}`);
				report("error");
			})
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	}

	/** Start the detached swap. Called from will-quit; idempotent. */
	function startSwap() {
		if (!staged && download) {
			// Quitting mid-download: stop it and remove the partial files now.
			download.abort();
			try { fs.rmSync(download.workdir, { recursive: true, force: true }); } catch { /* reclaimed next launch */ }
			log("self-update: download cancelled at quit");
			return false;
		}
		if (!staged || swapStarted) return false;
		swapStarted = true;
		try {
			const { backup, stage } = backupPaths(bundlePath);
			fs.mkdirSync(path.dirname(markerFile), { recursive: true });
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			const marker = { version: staged.version, from: app.getVersion(), target: bundlePath, backup, startedAt: Date.now(), appPid: process.pid };
			// Marker BEFORE the helper exists (no install without one), then again
			// with the helper's PID so a racing launch can tell an install is running.
			fs.writeFileSync(markerFile, JSON.stringify(marker, null, 2));
			const child = spawnHelper({ workdir: staged.workdir, pid: process.pid, target: bundlePath, newApp: staged.app, backup, stage, relaunch: relaunchOnQuit, logFile, env, spawnImpl: deps.spawnImpl });
			// A failed spawn reports asynchronously; without a listener it would crash the quitting app (round-4 hunt finding).
			child?.on?.("error", (err) => {
				log(`self-update: the installer did not start: ${err?.message ?? err}`);
				try { fs.rmSync(markerFile, { force: true }); } catch { /* settled as not-updated next launch */ }
			});
			if (Number.isInteger(child?.pid)) {
				fs.writeFileSync(markerFile, JSON.stringify({ ...marker, helperPid: child.pid }, null, 2));
				// The helper outlives this process: it co-owns the staged folder, so another copy's cleanup leaves it be.
				fs.writeFileSync(path.join(staged.workdir, OWNER_FILE), `${process.pid} ${child.pid}`);
			}
			log(`self-update: installing ${staged.version} after quit (relaunch: ${relaunchOnQuit})`);
			return true;
		} catch (err) {
			log(`self-update: could not start the installer: ${err?.message ?? err}`);
			return false;
		}
	}

	/** "Restart to update": stop the server, then quit; will-quit swaps. */
	function installNow() {
		if (!staged) return;
		relaunchOnQuit = true;
		try {
			killServer();
		} catch {
			/* already dead */
		}
		app.quit();
	}

	return { check, installNow, startSwap, bundlePath, feedBase: base, get staged() { return staged; } };
}

module.exports = {
	DEFAULT_FEED,
	MANUAL_DOWNLOAD_URL,
	FIRST_CHECK_DELAY_MS,
	CHECK_INTERVAL_HOURS,
	CHECK_INTERVAL_MS,
	AFTER_INSTALL_ARG,
	HELPER_SCRIPT,
	wantsSelfUpdater,
	parseVersion,
	compareVersions,
	parseFeed,
	feedBase,
	resolveFileURL,
	verifyFile,
	downloadToFile,
	assertNoEscapingLinks,
	bundleLocationProblem,
	bundleFromExecPath,
	extractAndVerify,
	backupPaths,
	isOwnBackup,
	spawnHelper,
	finishPendingUpdate,
	markerPath,
	reclaimAbandonedDownloads,
	yieldToPendingInstall,
	createMacSelfUpdater,
};
