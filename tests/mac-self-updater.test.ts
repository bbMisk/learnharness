/** macOS self-updater (owner design, 2026-11-03): pure parts, the real swap
 * helper against fake .app folders in a temp dir, backup cleanup, the updater
 * flow with a fake fetch, and the release preflight with a fake command
 * runner. Nothing here touches the network, the real app, /Applications, or
 * the user's data. ditto/plutil cases run on macOS only; the shell-helper
 * cases run anywhere with /bin/sh. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const updater = require("../electron/mac-self-updater.cjs");
const isMac = process.platform === "darwin";
const notRoot = process.getuid?.() !== 0;

const temps: string[] = [];
function tempDir() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-self-update-test-")));
	temps.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of temps.splice(0)) {
		spawnSync("/bin/chmod", ["-R", "u+w", dir]);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const sha512 = (data: Buffer | string) => createHash("sha512").update(data).digest("base64");
const ZIP_SHA = sha512("zip");

/* ── Versions and feed ──────────────────────────────────────────────────── */

describe("compareVersions", () => {
	it("follows SemVer precedence, including this app's preview versions", () => {
		const ordered = ["0.3.9", "0.4.0-preview.2", "0.4.0-preview.10", "0.4.0", "0.9.9", "0.10.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
		for (let i = 0; i < ordered.length - 1; i++) {
			assert.equal(updater.compareVersions(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
			assert.equal(updater.compareVersions(ordered[i + 1], ordered[i]), 1, `${ordered[i + 1]} > ${ordered[i]}`);
		}
		assert.equal(updater.compareVersions("v2.0.0", "2.0.0+build.5"), 0);
	});

	it("rejects invalid versions", () => {
		for (const bad of ["1.0", "latest", "01.0.0"]) assert.throws(() => updater.compareVersions(bad, "1.0.0"), /invalid version/);
	});
});

const VALID_FEED = `version: 0.4.1
files:
  - url: LearnHarness-0.4.1-arm64.dmg
    sha512: ${sha512("dmg")}
    size: 234567
  - url: LearnHarness-0.4.1-arm64-mac.zip
    sha512: ${ZIP_SHA}
    size: 123456
path: LearnHarness-0.4.1-arm64-mac.zip
releaseDate: '2026-11-03T00:00:00.000Z'
`;

describe("parseFeed", () => {
	it("reads the version and the zip from an electron-builder latest-mac.yml", () => {
		assert.deepEqual(updater.parseFeed(VALID_FEED), { version: "0.4.1", zip: { url: "LearnHarness-0.4.1-arm64-mac.zip", sha512: ZIP_SHA, size: 123456 } });
		assert.equal(updater.feedBase(undefined), "https://github.com/bbMisk/learnharness/releases/latest/download/");
		assert.equal(updater.feedBase("http://127.0.0.1:8123"), "http://127.0.0.1:8123/");
	});

	for (const [label, text, error] of [
		["invalid version", VALID_FEED.replace("version: 0.4.1", "version: 1.10"), /no valid version/],
		["no zip", VALID_FEED.replace("arm64-mac.zip\n    sha512", "arm64.tar\n    sha512"), /no zip/],
		["truncated sha512", VALID_FEED.replace(`sha512: ${ZIP_SHA}`, "sha512: abc="), /sha512/],
		["negative size", VALID_FEED.replace("size: 123456", "size: -5"), /size/],
		["bad yaml", "version: [0.4.1\nfiles: {", /not valid YAML/],
		["empty", "", /not a mapping/],
	] as const) {
		it(`rejects a feed with ${label}`, () => assert.throws(() => updater.parseFeed(text), error));
	}
});

describe("bundleLocationProblem", () => {
	it("asks for a move from App Translocation or a disk image, and a manual download when the folder isn't writable", () => {
		const writable = () => {};
		const denied = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
		assert.equal(updater.bundleLocationProblem("/private/var/folders/ab/T/AppTranslocation/1234/d/LearnHarness.app", writable), "move");
		assert.equal(updater.bundleLocationProblem("/Volumes/LearnHarness 0.4.1/LearnHarness.app", writable), "move");
		assert.equal(updater.bundleLocationProblem("/Applications/LearnHarness.app", denied), "permission");
		const parent = path.join(tempDir(), "Applications");
		fs.mkdirSync(path.join(parent, "LearnHarness.app"), { recursive: true });
		assert.equal(updater.bundleLocationProblem(path.join(parent, "LearnHarness.app")), null);
		assert.equal(updater.bundleFromExecPath("/Applications/LearnHarness.app/Contents/MacOS/LearnHarness"), "/Applications/LearnHarness.app");
	});
});

/* ── The real helper script, run against fake bundles ──────────────────── */

function fakeApp(dir: string, content: string) {
	fs.mkdirSync(path.join(dir, "Contents", "MacOS"), { recursive: true });
	fs.writeFileSync(path.join(dir, "Contents", "which"), content);
}
const which = (dir: string) => fs.readFileSync(path.join(dir, "Contents", "which"), "utf8");

function helperScene() {
	const root = tempDir();
	const target = path.join(root, "Applications", "LearnHarness.app");
	fakeApp(target, "old");
	const workdir = path.join(root, "work");
	const newApp = path.join(workdir, "extracted", "LearnHarness.app");
	fakeApp(newApp, "new");
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	const opened = path.join(root, "opened.txt");
	// Fake `open`: records its arguments instead of launching anything.
	fs.writeFileSync(path.join(bin, "open"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${opened}"\n`, { mode: 0o755 });
	const { backup, stage } = updater.backupPaths(target, 42);
	return { root, target, workdir, newApp, bin, opened, backup, stage, logFile: path.join(root, "update-helper.log") };
}
type Scene = ReturnType<typeof helperScene>;

/** Fake `mv` that runs `script` when its arguments match `when`, then the real mv. */
const fakeMv = (s: Scene, when: string, script: string) => fs.writeFileSync(path.join(s.bin, "mv"), `#!/bin/sh\nif ${when}; then ${script}; fi\nexec /bin/mv "$@"\n`, { mode: 0o755 });

function startHelper(s: Scene, { pid = 999999, relaunch = true } = {}) {
	let helper: ChildProcess | null = null;
	updater.spawnHelper({
		workdir: s.workdir, pid, target: s.target, newApp: s.newApp, backup: s.backup, stage: s.stage,
		relaunch, logFile: s.logFile, env: { LH_USER_DATA_DIR: "/tmp/lh-drill-data", HOME: "/should/not/pass" },
		searchPath: `${s.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
		spawnImpl: (cmd: string, args: string[], options: object) => (helper = spawn(cmd, args, options)),
	});
	const exited = new Promise<number | null>((resolve) => helper!.on("exit", resolve));
	return { helper: helper!, exited, log: () => (fs.existsSync(s.logFile) ? fs.readFileSync(s.logFile, "utf8") : "") };
}
const opened = (s: Scene) => (fs.existsSync(s.opened) ? fs.readFileSync(s.opened, "utf8").trim().split("\n") : []);

describe("swap helper (real /bin/sh against fake bundles)", () => {
	it("waits for the app to exit, swaps, keeps a backup, cleans temp, and relaunches with the drill env", async () => {
		const s = helperScene();
		const app = spawn("/bin/sleep", ["0.4"]);
		const started = Date.now();
		const h = startHelper(s, { pid: app.pid });
		assert.equal(await h.exited, 0, h.log());
		assert.ok(Date.now() - started >= 350, "waited for the app to exit");
		assert.equal(which(s.target), "new");
		assert.equal(which(s.backup), "old");
		assert.equal(fs.existsSync(s.stage), false);
		assert.equal(fs.existsSync(s.workdir), false, "temp workdir removed");
		assert.deepEqual(opened(s), ["-n", "--env", "LH_USER_DATA_DIR=/tmp/lh-drill-data", s.target]);
		assert.match(h.log(), /installed; previous version kept/);
	});

	it("does not relaunch after an install-on-quit", async () => {
		const s = helperScene();
		const h = startHelper(s, { relaunch: false });
		assert.equal(await h.exited, 0);
		assert.equal(which(s.target), "new");
		assert.deepEqual(opened(s), []);
	});

	it("rolls back to the previous version when moving the new one into place fails", async () => {
		const s = helperScene();
		fakeMv(s, `[ "$1" = "${s.stage}" ]`, "exit 1");
		const h = startHelper(s);
		assert.equal(await h.exited, 1);
		assert.equal(which(s.target), "old", "previous version restored in place");
		for (const gone of [s.backup, s.stage, s.workdir]) assert.equal(fs.existsSync(gone), false, gone);
		assert.match(h.log(), /previous version restored/);
		assert.deepEqual(opened(s).at(-1), s.target, "relaunches the old app");
	});

	it("leaves the current app untouched when staging fails", async () => {
		const s = helperScene();
		fs.rmSync(s.newApp, { recursive: true });
		const h = startHelper(s);
		assert.equal(await h.exited, 1);
		assert.equal(which(s.target), "old");
		assert.equal(fs.existsSync(s.backup), false);
		assert.match(h.log(), /install failed; keeping the previous version/);
	});

	it("a TERM between the two moves (shutdown) puts the previous version back", async () => {
		const s = helperScene();
		const reached = path.join(s.root, "reached");
		// Stall the final STAGE → TARGET move: the app path is empty while it sleeps.
		fakeMv(s, `[ "$1" = "${s.stage}" ]`, `: > "${reached}"; sleep 5`);
		const h = startHelper(s, { relaunch: false });
		for (let i = 0; i < 100 && !fs.existsSync(reached); i++) await new Promise((r) => setTimeout(r, 50));
		assert.equal(fs.existsSync(s.target), false, "app path empty inside the gap");
		process.kill(-h.helper.pid!, "SIGTERM"); // the whole detached group, as a shutdown would
		await h.exited;
		assert.equal(which(s.target), "old", "previous version back in place");
		for (const gone of [s.backup, s.stage, s.workdir]) assert.equal(fs.existsSync(gone), false, gone);
		assert.match(h.log(), /interrupted[\s\S]*previous version restored/);
	});
});

/* ── Backup cleanup on the next start ──────────────────────────────────── */

describe("finishPendingUpdate", () => {
	function scene({ backupName, withBackup = true }: { backupName?: string; withBackup?: boolean } = {}) {
		const root = tempDir();
		const target = path.join(root, "Applications", "LearnHarness.app");
		fakeApp(target, "new");
		const backup = backupName ? path.join(root, backupName) : updater.backupPaths(target, 7).backup;
		if (withBackup) fakeApp(backup, "old");
		const markerFile = updater.markerPath(path.join(root, "userData"), target);
		fs.mkdirSync(path.dirname(markerFile), { recursive: true });
		fs.writeFileSync(markerFile, JSON.stringify({ version: "0.4.1", from: "0.4.0", target, backup }));
		const finish = (version: string) => updater.finishPendingUpdate({ markerFile, bundlePath: target, version });
		return { target, backup, markerFile, finish };
	}

	it("removes the backup and marker once the new version is running", async () => {
		const s = scene();
		assert.equal(await s.finish("0.4.1"), "cleaned");
		assert.equal(fs.existsSync(s.backup), false);
		assert.equal(fs.existsSync(s.markerFile), false);
		assert.equal(which(s.target), "new");
	});

	it("keeps the marker while the swap's backup exists, so the new version still cleans up", async () => {
		const s = scene();
		assert.equal(await s.finish("0.4.0"), "pending");
		assert.ok(fs.existsSync(s.markerFile) && fs.existsSync(s.backup));
		assert.equal(await s.finish("0.4.1"), "cleaned");
	});

	it("clears the marker when the install never happened or rolled back", async () => {
		const s = scene({ withBackup: false });
		assert.equal(await s.finish("0.4.0"), "not-updated");
		assert.equal(fs.existsSync(s.markerFile), false);
	});

	it("never deletes a path that is not this app's sibling backup", async () => {
		const s = scene({ backupName: "Important Folder" });
		assert.equal(await s.finish("0.4.1"), "ignored");
		assert.equal(fs.existsSync(s.backup), true);
		assert.equal(fs.existsSync(s.markerFile), false);
	});

	it("keeps the marker and retries when the backup can't be removed", { skip: !notRoot }, async () => {
		const s = scene();
		fs.chmodSync(s.backup, 0o500); // its contents can't be removed
		assert.equal(await s.finish("0.4.1"), "cleanup-failed");
		assert.ok(fs.existsSync(s.markerFile));
		fs.chmodSync(s.backup, 0o700);
		assert.equal(await s.finish("0.4.1"), "cleaned");
	});

	it("does nothing without a marker, and markers are keyed by installation path", async () => {
		assert.equal(await updater.finishPendingUpdate({ markerFile: path.join(tempDir(), "none.json"), bundlePath: "/x/LearnHarness.app", version: "1.0.0" }), "none");
		assert.notEqual(updater.markerPath("/u", "/Applications/LearnHarness.app"), updater.markerPath("/u", "/Users/me/Applications/LearnHarness.app"));
	});
});

describe("removeOldDownloads", () => {
	it("removes lh-update-* folders older than a day and nothing else", async () => {
		const tmp = tempDir();
		const old = path.join(tmp, "lh-update-old");
		const fresh = path.join(tmp, "lh-update-fresh");
		const other = path.join(tmp, "other-old");
		for (const dir of [old, fresh, other]) fs.mkdirSync(dir);
		const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
		fs.utimesSync(old, dayAgo, dayAgo);
		fs.utimesSync(other, dayAgo, dayAgo);
		await updater.removeOldDownloads(tmp);
		assert.deepEqual(fs.readdirSync(tmp).sort(), ["lh-update-fresh", "other-old"]);
	});
});

/* ── The updater flow with a fake fetch ──────────────────────────────────── */

function plist(id: string, version: string) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`;
}
function realApp(dir: string, { id = "com.learnharness.LearnHarness", version = "0.4.1" } = {}) {
	fakeApp(dir, "new");
	fs.writeFileSync(path.join(dir, "Contents", "Info.plist"), plist(id, version));
}

/** A zip like electron-builder's (one LearnHarness.app at the top). zip -y
 * stores symlinks as links. */
function makeZip(build: (src: string) => void = (src) => realApp(path.join(src, "LearnHarness.app"))) {
	const root = tempDir();
	const src = path.join(root, "src");
	fs.mkdirSync(src);
	build(src);
	const zip = path.join(root, "out.zip");
	const r = spawnSync("/usr/bin/zip", ["-qry", zip, "."], { cwd: src });
	assert.equal(r.status, 0, String(r.stderr));
	return fs.readFileSync(zip);
}

function feedFor(version: string, zip: Buffer, overrides: { sha512?: string; size?: number } = {}) {
	return `version: ${version}\nfiles:\n  - url: LearnHarness-${version}-arm64-mac.zip\n    sha512: ${overrides.sha512 ?? sha512(zip)}\n    size: ${overrides.size ?? zip.length}\n`;
}

type Spawned = { cmd: string; args: string[]; options: { env: Record<string, string>; detached: boolean } };
function flow({ feed, zip, execPath, zipResponse, spawnImpl }: { feed: string; zip?: Buffer; execPath?: string; zipResponse?: () => Response; spawnImpl?: () => unknown }) {
	const root = tempDir();
	const userData = path.join(root, "userData");
	const tmp = path.join(root, "tmp");
	fs.mkdirSync(tmp);
	const target = path.join(root, "Applications", "LearnHarness.app");
	fs.mkdirSync(target, { recursive: true });
	const statuses: { status: string; version: string | null }[] = [];
	const requests: string[] = [];
	const spawned: Spawned[] = [];
	const lines: string[] = [];
	let quits = 0;
	const u = updater.createMacSelfUpdater({
		app: { getPath: () => userData, getVersion: () => "0.4.0", quit: () => quits++ },
		log: (line: string) => lines.push(line),
		report: (status: string, version: string | null = null) => statuses.push({ status, version }),
		env: { LH_UPDATE_FEED: "http://127.0.0.1:9/feed" },
		execPath: execPath ?? path.join(target, "Contents", "MacOS", "LearnHarness"),
		bundleId: "com.learnharness.LearnHarness",
		tmpdir: tmp,
		fetchImpl: async (url: string) => {
			requests.push(url);
			if (url.endsWith("latest-mac.yml")) return new Response(feed);
			if (zipResponse && url.endsWith(".zip")) return zipResponse();
			if (zip && url.endsWith(".zip")) return new Response(new Uint8Array(zip));
			return new Response("missing", { status: 404 });
		},
		spawnImpl: spawnImpl ?? ((cmd: string, args: string[], options: Spawned["options"]) => {
			spawned.push({ cmd, args, options });
			return { pid: 31337, unref() {} };
		}),
	});
	return { u, tmp, userData, target, statuses, requests, spawned, lines, markerFile: updater.markerPath(userData, target), quits: () => quits };
}
const last = (f: ReturnType<typeof flow>) => f.statuses.at(-1);
const ERROR = { status: "error", version: null };

describe("self-updater flow (fake fetch, temp dirs)", () => {
	it("reports up-to-date for the same or an older version without downloading", async () => {
		const f = flow({ feed: `version: 0.4.0\nfiles:\n  - url: a.zip\n    sha512: ${ZIP_SHA}\n    size: 3\n` });
		await f.u.check();
		assert.deepEqual(f.statuses.map((s) => s.status), ["checking", "up-to-date"]);
		assert.deepEqual(f.requests, ["http://127.0.0.1:9/feed/latest-mac.yml"]);
	});

	it("reports a generic error for a broken feed or a failed download, leaving no temp files", async () => {
		const broken = flow({ feed: "not: [valid" });
		await broken.u.check();
		assert.deepEqual(last(broken), ERROR);
		const missing = flow({ feed: VALID_FEED });
		await missing.u.check();
		assert.deepEqual(last(missing), ERROR);
		assert.deepEqual(fs.readdirSync(missing.tmp), []);
	});

	it("asks to move the app when it runs from a disk image, before downloading", async () => {
		const f = flow({ feed: VALID_FEED, execPath: "/Volumes/LearnHarness/LearnHarness.app/Contents/MacOS/LearnHarness" });
		await f.u.check();
		assert.deepEqual(last(f), { status: "move-to-applications", version: "0.4.1" });
		assert.equal(f.requests.length, 1, "no download");
	});

	it("offers the manual download when the app's folder is not writable", { skip: !notRoot }, async () => {
		const f = flow({ feed: VALID_FEED });
		fs.chmodSync(path.dirname(f.target), 0o555);
		await f.u.check();
		assert.deepEqual(last(f), { status: "manual-download", version: "0.4.1" });
		assert.equal(f.requests.length, 1, "no download");
	});

	it("downloads, verifies and stages a newer version, then installs on Restart with a marker", { skip: !isMac }, async () => {
		const zip = makeZip();
		const f = flow({ feed: feedFor("0.4.1", zip), zip });
		await f.u.check();
		assert.deepEqual(f.statuses.map((s) => s.status), ["checking", "downloading", "downloaded"]);
		assert.equal(last(f)!.version, "0.4.1");
		assert.equal(f.requests[1], "http://127.0.0.1:9/feed/LearnHarness-0.4.1-arm64-mac.zip");
		const staged = f.u.staged;
		assert.ok(fs.existsSync(path.join(staged.app, "Contents", "Info.plist")));
		assert.ok(staged.workdir.startsWith(f.tmp));
		await f.u.check();
		assert.equal(f.requests.length, 2, "a later check does not re-download");

		// Restart to update: quit; will-quit then starts the swap, once.
		f.u.installNow();
		assert.equal(f.quits(), 1);
		assert.equal(f.u.startSwap(), true);
		assert.equal(f.u.startSwap(), false, "only once");
		const call = f.spawned[0]!;
		assert.equal(call.cmd, "/bin/sh");
		assert.equal(call.options.detached, true);
		assert.deepEqual(call.args.slice(1, 4), [String(process.pid), f.target, staged.app]);
		assert.equal(call.args[7], "1", "relaunch after Restart");
		assert.deepEqual(call.options.env, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LH_UPDATE_FEED: "http://127.0.0.1:9/feed" });
		const marker = JSON.parse(fs.readFileSync(f.markerFile, "utf8"));
		assert.deepEqual(marker, { version: "0.4.1", from: "0.4.0", target: f.target, backup: call.args[4] });
		assert.ok(updater.isOwnBackup(f.target, marker.backup));
	});

	it("installs on a normal quit without relaunching", { skip: !isMac }, async () => {
		const zip = makeZip();
		const f = flow({ feed: feedFor("0.4.1", zip), zip });
		await f.u.check();
		assert.equal(f.u.startSwap(), true);
		assert.equal(f.spawned[0]!.args[7], "0");
	});

	it("does nothing on quit when no update is staged", () => {
		const f = flow({ feed: VALID_FEED });
		assert.equal(f.u.startSwap(), false);
		f.u.installNow();
		assert.equal(f.quits(), 0);
		assert.equal(f.spawned.length, 0);
	});

	it("an installer that fails to start is logged and its marker removed, not an unhandled error", { skip: !isMac }, async () => {
		const zip = makeZip();
		const child = Object.assign(new EventEmitter(), { unref() {} });
		const f = flow({ feed: feedFor("0.4.1", zip), zip, spawnImpl: () => child });
		await f.u.check();
		assert.equal(f.u.startSwap(), true);
		assert.ok(fs.existsSync(f.markerFile));
		child.emit("error", Object.assign(new Error("spawn /bin/sh EAGAIN"), { code: "EAGAIN" }));
		assert.ok(f.lines.some((l) => /installer did not start/.test(l)));
		assert.equal(fs.existsSync(f.markerFile), false);
	});

	it("a download write error becomes the error status with temp cleaned", async () => {
		const holder: { tmp?: string } = {};
		const f = flow({
			feed: feedFor("0.4.1", Buffer.from("abc")),
			zipResponse: () => {
				// Turn the download target into a directory before the body arrives (async EISDIR).
				const work = fs.readdirSync(holder.tmp!).find((n) => n.startsWith("lh-update-"))!;
				fs.mkdirSync(path.join(holder.tmp!, work, "update.zip"));
				return new Response(new ReadableStream({ async start(c) { await new Promise((r) => setTimeout(r, 100)); c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } }));
			},
		});
		holder.tmp = f.tmp;
		await f.u.check();
		assert.deepEqual(last(f), ERROR);
		assert.deepEqual(fs.readdirSync(f.tmp), []);
	});

	const app = (src: string) => path.join(src, "LearnHarness.app");
	for (const [label, build, overrides] of [
		["a sha512 mismatch", undefined, { sha512: ZIP_SHA }],
		["a size mismatch", undefined, { size: 1 }],
		["another app's bundle id", (src: string) => realApp(app(src), { id: "com.example.Other" }), {}],
		["a bundle version that differs from the feed", (src: string) => realApp(app(src), { version: "0.4.2" }), {}],
		["a top-level app that is a symlink", (src: string) => { realApp(path.join(src, "payload")); fs.symlinkSync("payload", app(src)); }, {}],
		["a link that leaves the bundle", (src: string) => { realApp(app(src)); fs.mkdirSync(path.join(src, "outside")); fs.symlinkSync("../../outside", path.join(app(src), "Contents", "evil")); }, {}],
	] as const) {
		it(`refuses ${label}: error status, nothing staged, temp cleaned`, { skip: !isMac }, async () => {
			const zip = makeZip(build);
			const f = flow({ feed: feedFor("0.4.1", zip, overrides), zip });
			await f.u.check();
			assert.deepEqual(last(f), ERROR);
			assert.equal(f.u.staged, null);
			assert.deepEqual(fs.readdirSync(f.tmp), []);
			assert.equal(f.u.startSwap(), false);
		});
	}

	it("accepts framework-style relative links inside the bundle", { skip: !isMac }, async () => {
		const zip = makeZip((src) => {
			realApp(app(src));
			const fw = path.join(app(src), "Contents", "Frameworks", "X.framework");
			fs.mkdirSync(path.join(fw, "Versions", "A"), { recursive: true });
			fs.writeFileSync(path.join(fw, "Versions", "A", "X"), "binary");
			fs.symlinkSync("A", path.join(fw, "Versions", "Current"));
			fs.symlinkSync("Versions/Current/X", path.join(fw, "X"));
		});
		const f = flow({ feed: feedFor("0.4.1", zip), zip });
		await f.u.check();
		assert.equal(last(f)!.status, "downloaded");
	});

	it("settles a previous install when it starts", async () => {
		const f = flow({ feed: VALID_FEED });
		await f.u.startup;
		const backup = updater.backupPaths(f.target, 1).backup;
		fakeApp(backup, "old");
		fs.mkdirSync(f.userData, { recursive: true });
		fs.writeFileSync(f.markerFile, JSON.stringify({ version: "0.4.0", target: f.target, backup }));
		const again = updater.createMacSelfUpdater({ app: { getPath: () => f.userData, getVersion: () => "0.4.0" }, log() {}, report() {}, env: {}, execPath: path.join(f.target, "Contents", "MacOS", "LearnHarness"), tmpdir: f.tmp });
		await again.startup;
		assert.equal(fs.existsSync(backup), false);
		assert.equal(fs.existsSync(f.markerFile), false);
	});
});

describe("assertNoEscapingLinks", () => {
	it("follows whole link chains: refuses ones that resolve outside, dangle or loop", async () => {
		const root = tempDir();
		const bundle = path.join(root, "LearnHarness.app");
		fs.mkdirSync(path.join(bundle, "b"), { recursive: true });
		fs.mkdirSync(path.join(root, "outside"));
		fs.symlinkSync("..", path.join(bundle, "b", "c"));
		fs.symlinkSync("b/c", path.join(bundle, "a"));
		await updater.assertNoEscapingLinks(bundle); // b/c and a both resolve to the bundle itself
		// Looks inside lexically; through a → b/c → .. it resolves outside.
		fs.symlinkSync("a/../outside", path.join(bundle, "escape"));
		await assert.rejects(updater.assertNoEscapingLinks(bundle), /leaving the bundle: escape/);
		for (const [name, target] of [["dangling", "missing"], ["loop", "loop"], ["abs", "/usr"]] as const) {
			const fresh = path.join(tempDir(), "LearnHarness.app");
			fs.mkdirSync(fresh);
			fs.symlinkSync(target, path.join(fresh, name));
			await assert.rejects(updater.assertNoEscapingLinks(fresh), /leaving the bundle/, name);
		}
	});
});

/* ── main.cjs selects the updater by the build-time flag ────────────────── */

describe("updater selection in main.cjs", () => {
	it("only builds flagged by the unsigned macOS config use the self-updater", () => {
		assert.equal(updater.wantsSelfUpdater("darwin", { lhMacUpdater: "self" }), true);
		assert.equal(updater.wantsSelfUpdater("darwin", {}), false, "Developer ID / default builds keep electron-updater");
		assert.equal(updater.wantsSelfUpdater("win32", { lhMacUpdater: "self" }), false);
		assert.equal(updater.wantsSelfUpdater("linux", { lhMacUpdater: "self" }), false);
		const config = fs.readFileSync(fileURLToPath(new URL("../electron-builder.unsigned-mac.yml", import.meta.url)), "utf8");
		assert.match(config, /extraMetadata:\n {2}lhMacUpdater: self/);
		assert.match(config, /identity: "-"/);
		assert.match(config, /notarize: false/);
	});

	function mainFixture(flag: boolean) {
		const file = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
		const mainRequire = createRequire(file);
		const calls = { updaterImports: 0, quitHandlers: 0 };
		const userData = tempDir();
		const context = {
			require: (id: string) => {
				if (id === "electron") return { app: { isPackaged: true, setName() {}, getPath: () => userData, getVersion: () => "0.4.0", requestSingleInstanceLock: () => false, quit() {}, on: (event: string) => { if (event === "will-quit") calls.quitHandlers++; } }, dialog: { showMessageBox() {} }, BrowserWindow: { getAllWindows: () => [] } };
				if (id === "node:fs") return { existsSync: () => true, mkdirSync() {}, appendFileSync() {} };
				if (id === "electron-updater") { calls.updaterImports++; return { autoUpdater: { on() {} } }; }
				if (id === "../package.json") return { version: "0.4.0", ...(flag ? { lhMacUpdater: "self" } : {}) };
				return mainRequire(id);
			},
			process: { platform: "darwin", resourcesPath: "/fixture/Resources", execPath: path.join(userData, "LearnHarness.app/Contents/MacOS/LearnHarness"), argv: [], env: {}, on() {} },
			console: { log() {} }, __dirname: path.dirname(file),
		};
		runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
		runInNewContext("setupAutoUpdater(); reportUpdateStatus('checking')", context);
		return { calls, selected: runInNewContext("selfUpdater !== null", context) as boolean, checkHours: runInNewContext("updateState.checkHours", context) as number };
	}

	it("a flagged macOS build wires the self-updater, install-on-quit and the 4-hour interval, not electron-updater", () => {
		assert.deepEqual(mainFixture(true), { calls: { updaterImports: 0, quitHandlers: 1 }, selected: true, checkHours: 4 });
	});

	it("an unflagged macOS build keeps electron-updater and its 24-hour interval", () => {
		assert.deepEqual(mainFixture(false), { calls: { updaterImports: 1, quitHandlers: 0 }, selected: false, checkHours: 24 });
	});
});

/* ── Release preflight (fake command runner) ─────────────────────────────── */

describe("release preflight", async () => {
	const { publishPreflight, isRepoURL, remoteTagCommit } = await import("../scripts/release-mac-preflight.mjs");
	const HEAD = "c".repeat(40);
	type Result = { ok: boolean; out: string; err?: string };
	function capture(overrides: Record<string, Result> = {}) {
		return (cmd: string, args: string[]): Result => {
			const key = `${cmd} ${args.join(" ")}`;
			for (const [prefix, value] of Object.entries(overrides)) if (key.startsWith(prefix)) return value;
			if (key === "git status --porcelain") return { ok: true, out: "" };
			if (key === "git rev-parse HEAD") return { ok: true, out: HEAD };
			if (key === "git remote get-url origin") return { ok: true, out: "https://github.com/bbMisk/learnharness.git" };
			if (key === "git fetch --quiet origin") return { ok: true, out: "" };
			if (key.startsWith("git branch -r --contains")) return { ok: true, out: "  origin/main" };
			if (key.startsWith("git ls-remote")) return { ok: true, out: "" };
			if (key === "gh auth status") return { ok: true, out: "" };
			if (key.startsWith("gh api repos/bbMisk/learnharness/releases/latest")) return { ok: true, out: "v0.4.0" };
			throw new Error(`unexpected ${key}`);
		};
	}
	const opts = { tag: "v0.4.1", repo: "bbMisk/learnharness" };
	const refuses = (overrides: Record<string, Result>, error: RegExp) => assert.throws(() => publishPreflight(capture(overrides), opts), error);

	it("returns HEAD when everything checks out, including no latest release yet", () => {
		assert.equal(publishPreflight(capture(), opts), HEAD);
		assert.equal(publishPreflight(capture({ "gh api": { ok: false, out: "", err: "gh: Not Found (HTTP 404)" } }), opts), HEAD);
		assert.equal(publishPreflight(capture({ "git ls-remote": { ok: true, out: `${HEAD}\trefs/tags/v0.4.1` } }), opts), HEAD, "tag already at HEAD");
	});

	it("refuses a dirty tree, another origin, unpushed HEAD, a tag elsewhere, gh signed out, or a version not newer than latest", () => {
		refuses({ "git status": { ok: true, out: " M package.json" } }, /not clean/);
		refuses({ "git remote get-url": { ok: true, out: "https://github.com/amosblomqvist/learnharness.git" } }, /origin" is not github.com/);
		refuses({ "git branch -r": { ok: true, out: "  upstream/main" } }, /not on any origin branch/);
		refuses({ "git fetch": { ok: false, out: "" } }, /not on any origin branch/);
		refuses({ "git ls-remote": { ok: true, out: `${"b".repeat(40)}\trefs/tags/v0.4.1` } }, /points at b+, not HEAD/);
		refuses({ "gh auth": { ok: false, out: "" } }, /not signed in/);
		for (const latest of ["v0.4.1", "v2.0.0", "v0.5.0-preview.1"]) refuses({ "gh api": { ok: true, out: latest } }, /not newer than the latest release/);
		refuses({ "gh api": { ok: false, out: "", err: "connection refused" } }, /could not read the latest release/);
	});

	it("parses remotes and annotated tags", () => {
		assert.ok(isRepoURL("https://github.com/bbMisk/learnharness.git", "bbMisk/learnharness"));
		assert.ok(isRepoURL("git@github.com:bbMisk/learnharness", "bbMisk/learnharness"));
		assert.ok(!isRepoURL("https://github.com/bbMisk/learnharness-web.git", "bbMisk/learnharness"));
		assert.ok(!isRepoURL("https://evilgithub.com/bbMisk/learnharness.git", "bbMisk/learnharness"));
		assert.equal(remoteTagCommit(`aaa\trefs/tags/v1\nbbb\trefs/tags/v1^{}`, "v1"), "bbb");
		assert.equal(remoteTagCommit("", "v1"), null);
	});
});
