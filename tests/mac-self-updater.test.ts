/** macOS self-updater (owner design, 2026-11-03): pure parts, the real swap
 * helper against fake .app folders in a temp dir, backup cleanup, and the
 * updater flow with a fake fetch. Nothing here touches the network, the
 * real app, /Applications, or the user's data. ditto/plutil cases run on
 * macOS only; the shell-helper cases run anywhere with /bin/sh. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, it } from "node:test";

const require = createRequire(import.meta.url);
const updater = require("../electron/mac-self-updater.cjs");
const isMac = process.platform === "darwin";

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

describe("compareVersions", () => {
	it("orders release versions numerically", () => {
		assert.equal(updater.compareVersions("0.10.0", "0.9.9"), 1);
		assert.equal(updater.compareVersions("1.2.3", "1.2.3"), 0);
		assert.equal(updater.compareVersions("1.2.3", "1.3.0"), -1);
		assert.equal(updater.compareVersions("v2.0.0", "2.0.0"), 0);
		assert.equal(updater.compareVersions("1.0.0+build.5", "1.0.0"), 0, "build metadata is ignored");
	});

	it("follows SemVer prerelease precedence", () => {
		const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
		for (let i = 0; i < ordered.length - 1; i++) {
			assert.equal(updater.compareVersions(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
			assert.equal(updater.compareVersions(ordered[i + 1], ordered[i]), 1, `${ordered[i + 1]} > ${ordered[i]}`);
		}
	});

	it("handles this app's preview versions", () => {
		assert.equal(updater.compareVersions("0.4.0-preview.3", "0.4.0-preview.2"), 1);
		assert.equal(updater.compareVersions("0.4.0-preview.10", "0.4.0-preview.9"), 1);
		assert.equal(updater.compareVersions("0.4.0", "0.4.0-preview.2"), 1);
		assert.equal(updater.compareVersions("0.4.0-preview.2", "0.3.9"), 1);
	});

	it("rejects invalid versions", () => {
		assert.throws(() => updater.compareVersions("1.0", "1.0.0"), /invalid version/);
		assert.throws(() => updater.compareVersions("1.0.0", "latest"), /invalid version/);
		assert.throws(() => updater.compareVersions("01.0.0", "1.0.0"), /invalid version/);
	});
});

const ZIP_SHA = sha512("zip");
const DMG_SHA = sha512("dmg");
const VALID_FEED = `version: 0.4.1
files:
  - url: LearnHarness-0.4.1-arm64-mac.zip
    sha512: ${ZIP_SHA}
    size: 123456
  - url: LearnHarness-0.4.1-arm64.dmg
    sha512: ${DMG_SHA}
    size: 234567
path: LearnHarness-0.4.1-arm64-mac.zip
sha512: ${ZIP_SHA}
releaseDate: '2026-11-03T00:00:00.000Z'
`;

describe("parseFeed", () => {
	it("reads version and files from an electron-builder latest-mac.yml", () => {
		const feed = updater.parseFeed(VALID_FEED);
		assert.equal(feed.version, "0.4.1");
		assert.equal(feed.files.length, 2);
		assert.deepEqual(feed.zip, { url: "LearnHarness-0.4.1-arm64-mac.zip", sha512: ZIP_SHA, size: 123456 });
	});

	it("finds the zip even when it is not listed first", () => {
		const feed = updater.parseFeed(`version: 1.0.0-preview.1\nfiles:\n  - url: a.dmg\n    sha512: ${DMG_SHA}\n    size: 1\n  - url: a-mac.zip\n    sha512: ${ZIP_SHA}\n    size: 2\n`);
		assert.equal(feed.version, "1.0.0-preview.1");
		assert.equal(feed.zip.url, "a-mac.zip");
	});

	for (const [label, text, error] of [
		["missing version", VALID_FEED.replace("version: 0.4.1\n", ""), /no valid version/],
		["invalid version", VALID_FEED.replace("version: 0.4.1", "version: 1.10"), /no valid version/],
		["missing files", `version: 0.4.1\npath: x.zip\n`, /no files/],
		["empty files", `version: 0.4.1\nfiles: []\n`, /no files/],
		["file without url", VALID_FEED.replace("  - url: LearnHarness-0.4.1-arm64-mac.zip\n", "  - name: x\n"), /no url/],
		["file without sha512", VALID_FEED.replace(`    sha512: ${ZIP_SHA}\n    size: 123456`, "    size: 123456"), /sha512/],
		["truncated sha512", VALID_FEED.replace(`    sha512: ${ZIP_SHA}\n    size: 123456`, "    sha512: abc=\n    size: 123456"), /sha512/],
		["missing size", VALID_FEED.replace("    size: 123456\n", ""), /size/],
		["negative size", VALID_FEED.replace("size: 123456", "size: -5"), /size/],
		["no zip", VALID_FEED.replace("arm64-mac.zip\n    sha512", "arm64.tar\n    sha512"), /no zip/],
		["bad yaml", "version: [0.4.1\nfiles: {", /not valid YAML/],
		["not a mapping", "- just\n- a list\n", /not a mapping/],
		["empty", "", /not a mapping/],
	] as const) {
		it(`rejects a feed with ${label}`, () => assert.throws(() => updater.parseFeed(text), error));
	}

	it("resolves file names against the feed base, and only over http(s)", () => {
		assert.equal(updater.feedBase(undefined), "https://github.com/bbMisk/learnharness/releases/latest/download/");
		assert.equal(updater.feedBase("http://127.0.0.1:8123"), "http://127.0.0.1:8123/");
		assert.equal(updater.resolveFileURL(updater.feedBase(undefined), "LearnHarness-0.4.1-arm64-mac.zip"), "https://github.com/bbMisk/learnharness/releases/latest/download/LearnHarness-0.4.1-arm64-mac.zip");
		assert.throws(() => updater.resolveFileURL("http://127.0.0.1/", "file:///etc/passwd"), /refusing/);
	});
});

describe("verifyFile", () => {
	it("accepts a matching size and base64 sha512", async () => {
		const file = path.join(tempDir(), "update.zip");
		fs.writeFileSync(file, "payload bytes");
		await updater.verifyFile(file, { size: 13, sha512: sha512("payload bytes") });
	});

	it("rejects a size mismatch", async () => {
		const file = path.join(tempDir(), "update.zip");
		fs.writeFileSync(file, "payload bytes");
		await assert.rejects(updater.verifyFile(file, { size: 14, sha512: sha512("payload bytes") }), /size mismatch/);
	});

	it("rejects same-size content with a different hash", async () => {
		const file = path.join(tempDir(), "update.zip");
		fs.writeFileSync(file, "payload bytes");
		await assert.rejects(updater.verifyFile(file, { size: 13, sha512: sha512("PAYLOAD BYTES") }), /sha512 mismatch/);
	});
});

describe("bundleLocationProblem", () => {
	const writable = () => {};
	it("flags App Translocation", () => {
		assert.equal(updater.bundleLocationProblem("/private/var/folders/ab/cd/T/AppTranslocation/1234-ABCD/d/LearnHarness.app", writable), "move");
	});
	it("flags a mounted disk image", () => {
		assert.equal(updater.bundleLocationProblem("/Volumes/LearnHarness 0.4.1/LearnHarness.app", writable), "move");
	});
	it("flags a parent folder the user can't write", () => {
		const denied = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
		assert.equal(updater.bundleLocationProblem("/Applications/LearnHarness.app", denied), "permission");
	});
	it("flags a real read-only parent", { skip: process.getuid?.() === 0 }, () => {
		const parent = path.join(tempDir(), "ReadOnly");
		fs.mkdirSync(path.join(parent, "LearnHarness.app"), { recursive: true });
		fs.chmodSync(parent, 0o555);
		assert.equal(updater.bundleLocationProblem(path.join(parent, "LearnHarness.app")), "permission");
	});
	it("accepts a writable location", () => {
		const parent = path.join(tempDir(), "Applications");
		fs.mkdirSync(path.join(parent, "LearnHarness.app"), { recursive: true });
		assert.equal(updater.bundleLocationProblem(path.join(parent, "LearnHarness.app")), null);
	});
	it("finds the bundle from the executable path", () => {
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
	const apps = path.join(root, "Applications");
	const target = path.join(apps, "LearnHarness.app");
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
	const logFile = path.join(root, "update-helper.log");
	return { root, target, workdir, newApp, bin, opened, backup, stage, logFile };
}

async function runHelper(scene: ReturnType<typeof helperScene>, { relaunch = true, fakePidMs = 400 } = {}) {
	const fake = spawn("/bin/sleep", [String(fakePidMs / 1000)]);
	let helper: ChildProcess | null = null;
	const started = Date.now();
	updater.spawnHelper({
		workdir: scene.workdir, pid: fake.pid, target: scene.target, newApp: scene.newApp, backup: scene.backup, stage: scene.stage,
		relaunch, logFile: scene.logFile, env: { LH_USER_DATA_DIR: "/tmp/lh-drill-data", HOME: "/should/not/pass" },
		searchPath: `${scene.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
		spawnImpl: (cmd: string, args: string[], options: object) => (helper = spawn(cmd, args, options)),
	});
	const code = await new Promise<number | null>((resolve) => helper!.on("exit", resolve));
	return { code, elapsed: Date.now() - started, log: fs.existsSync(scene.logFile) ? fs.readFileSync(scene.logFile, "utf8") : "" };
}

describe("swap helper (real /bin/sh against fake bundles)", () => {
	it("waits for the app to exit, swaps, keeps a backup, cleans temp, and relaunches with the drill env", async () => {
		const scene = helperScene();
		const { code, elapsed, log } = await runHelper(scene);
		assert.equal(code, 0, log);
		assert.ok(elapsed >= 350, `waited for the fake PID (${elapsed} ms)`);
		assert.equal(which(scene.target), "new");
		assert.equal(which(scene.backup), "old");
		assert.equal(fs.existsSync(scene.stage), false);
		assert.equal(fs.existsSync(scene.workdir), false, "temp workdir removed");
		assert.deepEqual(fs.readFileSync(scene.opened, "utf8").trim().split("\n"), ["-n", "--env", "LH_USER_DATA_DIR=/tmp/lh-drill-data", scene.target]);
		assert.match(log, /installed; previous version kept/);
	});

	it("does not relaunch after an install-on-quit", async () => {
		const scene = helperScene();
		const { code } = await runHelper(scene, { relaunch: false, fakePidMs: 50 });
		assert.equal(code, 0);
		assert.equal(which(scene.target), "new");
		assert.equal(fs.existsSync(scene.opened), false);
	});

	it("rolls back to the previous version when moving the new one into place fails", async () => {
		const scene = helperScene();
		// Fake mv that fails only for the final STAGE → TARGET move.
		fs.writeFileSync(path.join(scene.bin, "mv"), `#!/bin/sh\nif [ "$1" = "${scene.stage}" ]; then exit 1; fi\nexec /bin/mv "$@"\n`, { mode: 0o755 });
		const { code, log } = await runHelper(scene, { fakePidMs: 50 });
		assert.equal(code, 1);
		assert.equal(which(scene.target), "old", "previous version restored in place");
		assert.equal(fs.existsSync(scene.backup), false);
		assert.equal(fs.existsSync(scene.stage), false);
		assert.equal(fs.existsSync(scene.workdir), false);
		assert.match(log, /restoring the previous version/);
		assert.match(log, /previous version restored/);
		assert.deepEqual(fs.readFileSync(scene.opened, "utf8").trim().split("\n").at(-1), scene.target, "relaunches the old app");
	});

	it("leaves the current app untouched when staging fails", async () => {
		const scene = helperScene();
		fs.rmSync(scene.newApp, { recursive: true });
		const { code, log } = await runHelper(scene, { fakePidMs: 50 });
		assert.equal(code, 1);
		assert.equal(which(scene.target), "old");
		assert.equal(fs.existsSync(scene.backup), false);
		assert.match(log, /could not stage/);
	});
});

describe("backup cleanup on the next start", () => {
	function scene(version: string, backupName?: string) {
		const root = tempDir();
		const target = path.join(root, "Applications", "LearnHarness.app");
		fakeApp(target, "new");
		const backup = backupName ? path.join(root, backupName) : updater.backupPaths(target, 7).backup;
		fakeApp(backup, "old");
		const markerFile = path.join(root, "userData", "self-update.json");
		fs.mkdirSync(path.dirname(markerFile), { recursive: true });
		fs.writeFileSync(markerFile, JSON.stringify({ version, from: "0.4.0", target, backup }));
		return { target, backup, markerFile };
	}

	it("removes the backup and marker once the new version is running", async () => {
		const s = scene("0.4.1");
		const lines: string[] = [];
		assert.equal(await updater.finishPendingUpdate({ markerFile: s.markerFile, bundlePath: s.target, version: "0.4.1", log: (l: string) => lines.push(l) }), "cleaned");
		assert.equal(fs.existsSync(s.backup), false);
		assert.equal(fs.existsSync(s.markerFile), false);
		assert.equal(which(s.target), "new");
		assert.match(lines.join("\n"), /removed the previous version's backup/);
	});

	it("keeps the backup when the old version is still the one running", async () => {
		const s = scene("0.4.1");
		assert.equal(await updater.finishPendingUpdate({ markerFile: s.markerFile, bundlePath: s.target, version: "0.4.0" }), "not-updated");
		assert.equal(fs.existsSync(s.backup), true);
		assert.equal(fs.existsSync(s.markerFile), false);
	});

	it("never deletes a path that is not this app's sibling backup", async () => {
		const s = scene("0.4.1", "Important Folder");
		assert.equal(await updater.finishPendingUpdate({ markerFile: s.markerFile, bundlePath: s.target, version: "0.4.1" }), "ignored");
		assert.equal(fs.existsSync(s.backup), true);
		assert.equal(fs.existsSync(s.markerFile), false);
	});

	it("does nothing without a marker", async () => {
		assert.equal(await updater.finishPendingUpdate({ markerFile: path.join(tempDir(), "self-update.json"), bundlePath: "/x/LearnHarness.app", version: "1.0.0" }), "none");
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

/** A zip like electron-builder's: one LearnHarness.app at the top. */
function makeZip(root: string, { id = "com.learnharness.LearnHarness", version = "0.4.1" } = {}) {
	const src = path.join(root, `zip-src-${id}-${version}`, "LearnHarness.app");
	fakeApp(src, "new");
	fs.writeFileSync(path.join(src, "Contents", "Info.plist"), plist(id, version));
	const zip = path.join(root, `update-${id}-${version}.zip`);
	const result = spawnSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", src, zip]);
	assert.equal(result.status, 0, String(result.stderr));
	return fs.readFileSync(zip);
}

function feedFor(version: string, zip: Buffer, overrides: { sha512?: string; size?: number } = {}) {
	return `version: ${version}\nfiles:\n  - url: LearnHarness-${version}-arm64-mac.zip\n    sha512: ${overrides.sha512 ?? sha512(zip)}\n    size: ${overrides.size ?? zip.length}\n`;
}

function flow(opts: { feed: string; zip?: Buffer; current?: string; execPath?: string }) {
	return flowWith(opts);
}

function flowWith({ feed, zip, current = "0.4.0", execPath, zipResponse }: { feed: string; zip?: Buffer; current?: string; execPath?: string; zipResponse?: () => Response }) {
	const root = tempDir();
	const userData = path.join(root, "userData");
	const tmp = path.join(root, "tmp");
	fs.mkdirSync(tmp);
	const target = path.join(root, "Applications", "LearnHarness.app");
	fs.mkdirSync(target, { recursive: true });
	const statuses: { status: string; version: string | null }[] = [];
	const requests: string[] = [];
	const spawned: { cmd: string; args: string[]; options: { env: Record<string, string>; detached: boolean } }[] = [];
	let quits = 0;
	let killed = 0;
	const u = updater.createMacSelfUpdater({
		app: { getPath: () => userData, getVersion: () => current, quit: () => quits++ },
		log: () => {},
		report: (status: string, version: string | null = null) => statuses.push({ status, version }),
		killServer: () => killed++,
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
		spawnImpl: (cmd: string, args: string[], options: { env: Record<string, string>; detached: boolean }) => {
			spawned.push({ cmd, args, options });
			return { pid: 31337, unref() {} };
		},
	});
	return { u, root, tmp, userData, target, statuses, requests, spawned, quits: () => quits, killed: () => killed };
}

describe("self-updater flow (fake fetch, temp dirs)", () => {
	it("reports up-to-date for the same or an older version without downloading", async () => {
		const f = flow({ feed: `version: 0.4.0\nfiles:\n  - url: a.zip\n    sha512: ${ZIP_SHA}\n    size: 3\n` });
		await f.u.check();
		assert.deepEqual(f.statuses.map((s) => s.status), ["checking", "up-to-date"]);
		assert.deepEqual(f.requests, ["http://127.0.0.1:9/feed/latest-mac.yml"]);
	});

	it("reports a generic error for a broken feed", async () => {
		const f = flow({ feed: "not: [valid" });
		await f.u.check();
		assert.deepEqual(f.statuses.at(-1), { status: "error", version: null });
	});

	it("asks to move the app when it runs from a disk image, before downloading", async () => {
		const f = flow({ feed: VALID_FEED, execPath: "/Volumes/LearnHarness/LearnHarness.app/Contents/MacOS/LearnHarness" });
		await f.u.check();
		assert.deepEqual(f.statuses.at(-1), { status: "move-to-applications", version: "0.4.1" });
		assert.equal(f.requests.length, 1, "no download");
	});

	it("offers the manual download when the app's folder is not writable", { skip: process.getuid?.() === 0 }, async () => {
		const f = flow({ feed: VALID_FEED });
		fs.chmodSync(path.dirname(f.target), 0o555);
		await f.u.check();
		assert.deepEqual(f.statuses.at(-1), { status: "manual-download", version: "0.4.1" });
		assert.equal(f.requests.length, 1, "no download");
	});

	it("downloads, verifies and stages a newer version, then installs on quit with a marker", { skip: !isMac }, async () => {
		const zip = makeZip(tempDir());
		const f = flow({ feed: feedFor("0.4.1", zip), zip });
		await f.u.check();
		assert.deepEqual(f.statuses.map((s) => s.status), ["checking", "downloading", "downloaded"]);
		assert.equal(f.statuses.at(-1)!.version, "0.4.1");
		assert.equal(f.requests[1], "http://127.0.0.1:9/feed/LearnHarness-0.4.1-arm64-mac.zip");
		const staged = f.u.staged;
		assert.ok(fs.existsSync(path.join(staged.app, "Contents", "Info.plist")));
		assert.ok(staged.workdir.startsWith(f.tmp));
		// A later check does not re-download.
		await f.u.check();
		assert.equal(f.requests.length, 2);
		assert.equal(f.statuses.at(-1)!.status, "downloaded");

		// Restart to update: kill the server, quit; will-quit then starts the swap.
		f.u.installNow();
		assert.equal(f.killed(), 1);
		assert.equal(f.quits(), 1);
		assert.equal(f.u.startSwap(), true);
		assert.equal(f.u.startSwap(), false, "only once");
		const call = f.spawned[0]!;
		assert.equal(call.cmd, "/bin/sh");
		assert.equal(call.options.detached, true);
		assert.equal(call.args[1], String(process.pid));
		assert.equal(call.args[2], f.target);
		assert.equal(call.args[3], staged.app);
		assert.equal(call.args[7], "1", "relaunch after Restart");
		assert.equal(call.options.env.LH_UPDATE_FEED, "http://127.0.0.1:9/feed");
		assert.equal(call.options.env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
		const marker = JSON.parse(fs.readFileSync(path.join(f.userData, "self-update.json"), "utf8"));
		const { startedAt, ...rest } = marker;
		assert.deepEqual(rest, { version: "0.4.1", from: "0.4.0", target: f.target, backup: call.args[4], helperPid: 31337 });
		assert.ok(Math.abs(Date.now() - startedAt) < 60_000);
		assert.ok(updater.isOwnBackup(f.target, marker.backup));
	});

	it("installs on a normal quit without relaunching", { skip: !isMac }, async () => {
		const zip = makeZip(tempDir());
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

	for (const [label, make, overrides, error] of [
		["a sha512 mismatch", () => makeZip(tempDir()), { sha512: ZIP_SHA }, "sha512"],
		["a size mismatch", () => makeZip(tempDir()), { size: 1 }, "size"],
		["another app's bundle id", () => makeZip(tempDir(), { id: "com.example.Other" }), {}, "id"],
		["a bundle version that differs from the feed", () => makeZip(tempDir(), { version: "0.4.2" }), {}, "version"],
	] as const) {
		it(`refuses ${label}: error status, nothing staged, temp cleaned`, { skip: !isMac }, async () => {
			const zip = make();
			const f = flow({ feed: feedFor("0.4.1", zip, overrides), zip });
			await f.u.check();
			assert.deepEqual(f.statuses.at(-1), { status: "error", version: null }, error);
			assert.equal(f.u.staged, null);
			assert.deepEqual(fs.readdirSync(f.tmp), []);
			assert.equal(f.u.startSwap(), false);
		});
	}

	it("a failed download leaves no temp files", async () => {
		const f = flow({ feed: VALID_FEED });
		await f.u.check();
		assert.equal(f.statuses.at(-1)!.status, "error");
		assert.deepEqual(fs.readdirSync(f.tmp), []);
	});
});

/* ── main.cjs selects the updater by the build-time flag ────────────────── */

describe("updater selection in main.cjs", () => {
	it("only builds flagged by the unsigned macOS config use the self-updater", () => {
		assert.equal(updater.wantsSelfUpdater("darwin", { lhMacUpdater: "self" }), true);
		assert.equal(updater.wantsSelfUpdater("darwin", {}), false, "Developer ID / default builds keep electron-updater");
		assert.equal(updater.wantsSelfUpdater("win32", { lhMacUpdater: "self" }), false);
		assert.equal(updater.wantsSelfUpdater("linux", { lhMacUpdater: "self" }), false);
		const config = readFileSync(fileURLToPath(new URL("../electron-builder.unsigned-mac.yml", import.meta.url)), "utf8");
		assert.match(config, /extraMetadata:\n {2}lhMacUpdater: self/);
		assert.match(config, /identity: "-"/);
		assert.match(config, /notarize: false/);
	});

	function mainFixture(flag: boolean) {
		const file = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
		const mainRequire = createRequire(file);
		const calls = { updaterImports: 0, quitHandlers: 0 };
		const context = {
			require: (id: string) => {
				if (id === "electron") return { app: { isPackaged: true, setName() {}, getPath: () => "/fixture-user-data", getVersion: () => "0.4.0", requestSingleInstanceLock: () => false, quit() {}, on: (event: string) => { if (event === "will-quit") calls.quitHandlers++; } }, dialog: { showMessageBox() {} } };
				if (id === "node:fs") return { existsSync: () => true, mkdirSync() {}, appendFileSync() {} };
				if (id === "electron-updater") { calls.updaterImports++; return { autoUpdater: { on() {} } }; }
				if (id === "../package.json") return { version: "0.4.0", ...(flag ? { lhMacUpdater: "self" } : {}) };
				return mainRequire(id);
			},
			process: { platform: "darwin", resourcesPath: "/fixture/Resources", execPath: "/fixture/LearnHarness.app/Contents/MacOS/LearnHarness", argv: [], env: {}, on() {} },
			console: { log() {} }, __dirname: path.dirname(file),
		};
		runInNewContext(readFileSync(file, "utf8"), context, { filename: file });
		runInNewContext("setupAutoUpdater()", context);
		return { calls, selected: runInNewContext("selfUpdater !== null", context) as boolean };
	}

	it("a flagged macOS build wires the self-updater and install-on-quit, not electron-updater", () => {
		const { calls, selected } = mainFixture(true);
		assert.equal(selected, true);
		assert.equal(calls.updaterImports, 0);
		assert.equal(calls.quitHandlers, 1);
	});

	it("an unflagged macOS build keeps electron-updater", () => {
		const { calls, selected } = mainFixture(false);
		assert.equal(selected, false);
		assert.equal(calls.updaterImports, 1);
		assert.equal(calls.quitHandlers, 0);
	});
});

/* ── Follow-up fixes (review of 56299e6) ─────────────────────────────────── */

/** A body that delivers its bytes only after a delay, so a write-side error
 * fires while the reader is still waiting. */
function delayedBody(bytes: Uint8Array, ms = 150) {
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			await new Promise((r) => setTimeout(r, ms));
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

describe("download write errors (fix 1)", () => {
	it("a write failure rejects instead of crashing the process", async () => {
		const dir = tempDir(); // writing to a directory path → async EISDIR
		const fetchImpl = async () => new Response(delayedBody(new Uint8Array([1, 2, 3])));
		await assert.rejects(updater.downloadToFile(fetchImpl, "http://127.0.0.1:9/x.zip", dir), /EISDIR|illegal operation/);
	});

	it("in the updater flow it becomes the error status with temp cleaned", async () => {
		const tmpHolder: { tmp?: string } = {};
		const f = flowWith({
			feed: feedFor("0.4.1", Buffer.from("abc")),
			zipResponse: () => {
				// Turn the download target into a directory just before the body arrives.
				const work = fs.readdirSync(tmpHolder.tmp!).find((n) => n.startsWith("lh-update-"))!;
				fs.mkdirSync(path.join(tmpHolder.tmp!, work, "update.zip"));
				return new Response(delayedBody(new Uint8Array(Buffer.from("abc"))));
			},
		});
		tmpHolder.tmp = f.tmp;
		await f.u.check();
		assert.deepEqual(f.statuses.at(-1), { status: "error", version: null });
		assert.deepEqual(fs.readdirSync(f.tmp), []);
	});
});

/** Build a zip with /usr/bin/zip -y so symlinks are stored as links. */
function zipWithLinks(build: (src: string) => void) {
	const root = tempDir();
	const src = path.join(root, "src");
	fs.mkdirSync(src);
	build(src);
	const zip = path.join(root, "out.zip");
	const r = spawnSync("/usr/bin/zip", ["-qry", zip, "."], { cwd: src });
	assert.equal(r.status, 0, String(r.stderr));
	return fs.readFileSync(zip);
}
function realApp(dir: string, version = "0.4.1") {
	fakeApp(dir, "new");
	fs.writeFileSync(path.join(dir, "Contents", "Info.plist"), plist("com.learnharness.LearnHarness", version));
}

describe("symlinks in the downloaded zip (fix 2)", { skip: !isMac }, () => {
	it("refuses a top-level LearnHarness.app that is a symlink", async () => {
		const zip = zipWithLinks((src) => {
			realApp(path.join(src, "payload"));
			fs.symlinkSync("payload", path.join(src, "LearnHarness.app"));
		});
		const f = flowWith({ feed: feedFor("0.4.1", zip), zip });
		await f.u.check();
		assert.deepEqual(f.statuses.at(-1), { status: "error", version: null });
		assert.equal(f.u.staged, null);
		assert.deepEqual(fs.readdirSync(f.tmp), []);
	});

	it("refuses a bundle holding a link that leaves the bundle", async () => {
		const zip = zipWithLinks((src) => {
			realApp(path.join(src, "LearnHarness.app"));
			fs.mkdirSync(path.join(src, "outside"));
			fs.symlinkSync("../../outside", path.join(src, "LearnHarness.app", "Contents", "evil"));
		});
		const f = flowWith({ feed: feedFor("0.4.1", zip), zip });
		await f.u.check();
		assert.deepEqual(f.statuses.at(-1), { status: "error", version: null });
		assert.equal(f.u.staged, null);
	});

	it("refuses an absolute link, even one that looks harmless", async () => {
		const root = tempDir();
		realApp(path.join(root, "LearnHarness.app"));
		fs.symlinkSync("/usr", path.join(root, "LearnHarness.app", "Contents", "abs"));
		await assert.rejects(updater.assertNoEscapingLinks(path.join(root, "LearnHarness.app")), /link leaving the bundle/);
	});

	it("accepts framework-style relative links inside the bundle", async () => {
		const zip = zipWithLinks((src) => {
			const app = path.join(src, "LearnHarness.app");
			realApp(app);
			const fw = path.join(app, "Contents", "Frameworks", "X.framework");
			fs.mkdirSync(path.join(fw, "Versions", "A"), { recursive: true });
			fs.symlinkSync("A", path.join(fw, "Versions", "Current"));
			fs.symlinkSync("Versions/Current/X", path.join(fw, "X"));
		});
		const f = flowWith({ feed: feedFor("0.4.1", zip), zip });
		await f.u.check();
		assert.equal(f.statuses.at(-1)!.status, "downloaded");
	});
});

describe("a launch during the install window (fix 3)", () => {
	function scene() {
		const root = tempDir();
		const target = path.join(root, "Applications", "LearnHarness.app");
		fakeApp(target, "new");
		const backup = updater.backupPaths(target, 9).backup;
		fakeApp(backup, "old");
		const userData = path.join(root, "userData");
		const markerFile = path.join(userData, "self-update.json");
		fs.mkdirSync(userData);
		const write = (extra: object = {}) => fs.writeFileSync(markerFile, JSON.stringify({ version: "0.4.1", from: "0.4.0", target, backup, startedAt: Date.now(), ...extra }));
		write();
		return { target, backup, userData, markerFile, write };
	}

	it("an old process started after the swap keeps the marker (the new version still cleans up)", async () => {
		const s = scene();
		const state = await updater.finishPendingUpdate({ markerFile: s.markerFile, bundlePath: s.target, version: "0.4.0", readVersion: async () => "0.4.1", isAlive: () => false });
		assert.equal(state, "stale");
		assert.ok(fs.existsSync(s.markerFile), "marker kept");
		assert.ok(fs.existsSync(s.backup), "backup kept");
		assert.equal(await updater.finishPendingUpdate({ markerFile: s.markerFile, bundlePath: s.target, version: "0.4.1" }), "cleaned");
		assert.equal(fs.existsSync(s.backup), false);
	});

	it("a live helper means an install is running: nothing is cleared", async () => {
		const s = scene();
		const helper = spawn("/bin/sleep", ["5"]);
		try {
			s.write({ helperPid: helper.pid });
			const state = await updater.finishPendingUpdate({ markerFile: s.markerFile, bundlePath: s.target, version: "0.4.0", readVersion: async () => "0.4.0" });
			assert.equal(state, "installing");
			assert.ok(fs.existsSync(s.markerFile));
		} finally {
			helper.kill();
		}
	});

	it("a helper PID from long ago is not trusted (PID reuse)", async () => {
		const s = scene();
		s.write({ helperPid: process.pid, startedAt: Date.now() - 60 * 60 * 1000 });
		assert.equal(await updater.finishPendingUpdate({ markerFile: s.markerFile, bundlePath: s.target, version: "0.4.0", readVersion: async () => "0.4.0" }), "not-updated");
		assert.equal(fs.existsSync(s.markerFile), false);
	});

	function fakeApp2(userData: string, version: string) {
		const calls: string[] = [];
		const relaunchArgs: string[][] = [];
		return {
			calls, relaunchArgs,
			app: {
				getPath: () => userData, getVersion: () => version,
				releaseSingleInstanceLock: () => calls.push("release"),
				relaunch: (o: { args: string[] }) => { calls.push("relaunch"); relaunchArgs.push(o.args); },
				exit: (code: number) => calls.push(`exit ${code}`),
			},
		};
	}

	it("the old process waits for the helper, then relaunches into the installed version", async () => {
		const s = scene();
		let alive = 3; // helper alive for three polls
		s.write({ helperPid: 4242 });
		const a = fakeApp2(s.userData, "0.4.0");
		const slept: number[] = [];
		const exiting = await updater.yieldToPendingInstall({
			app: a.app, execPath: path.join(s.target, "Contents", "MacOS", "LearnHarness"), argv: ["/x/LearnHarness", "--flag"],
			readVersion: async () => "0.4.0", isAlive: () => alive-- > 0, sleep: async (ms: number) => { slept.push(ms); },
		});
		assert.equal(exiting, true);
		assert.deepEqual(a.calls, ["release", "relaunch", "exit 0"]);
		assert.deepEqual(a.relaunchArgs[0], ["--flag", "--lh-after-install"]);
		assert.ok(slept.length >= 2, "waited for the helper");
		assert.ok(fs.existsSync(s.markerFile), "marker left for the new version");
	});

	it("a stale old process relaunches at once; never twice", async () => {
		const s = scene();
		const a = fakeApp2(s.userData, "0.4.0");
		const execPath = path.join(s.target, "Contents", "MacOS", "LearnHarness");
		assert.equal(await updater.yieldToPendingInstall({ app: a.app, execPath, argv: ["/x"], readVersion: async () => "0.4.1", isAlive: () => false }), true);
		const b = fakeApp2(s.userData, "0.4.0");
		assert.equal(await updater.yieldToPendingInstall({ app: b.app, execPath, argv: ["/x", "--lh-after-install"], readVersion: async () => "0.4.1", isAlive: () => false }), false);
		assert.deepEqual(b.calls, []);
	});

	it("the new version just cleans up and carries on", async () => {
		const s = scene();
		const a = fakeApp2(s.userData, "0.4.1");
		assert.equal(await updater.yieldToPendingInstall({ app: a.app, execPath: path.join(s.target, "Contents", "MacOS", "LearnHarness"), argv: ["/x"] }), false);
		assert.deepEqual(a.calls, []);
		assert.equal(fs.existsSync(s.backup), false);
	});
});

describe("release preflight (fix 4)", async () => {
	const { publishPreflight, remoteTagCommit } = await import("../scripts/release-mac-preflight.mjs");
	const HEAD = "a".repeat(40);
	const OTHER = "b".repeat(40);
	function runner(lsRemote: string, { releaseExists = false } = {}) {
		const seen: string[] = [];
		const capture = (cmd: string, args: string[]) => {
			const key = `${cmd} ${args.join(" ")}`;
			seen.push(key);
			if (key === "git status --porcelain") return { ok: true, out: "" };
			if (key === "git rev-parse HEAD") return { ok: true, out: HEAD };
			if (key.startsWith("git branch -r --contains")) return { ok: true, out: "origin/main" };
			if (key.startsWith("git ls-remote")) return { ok: true, out: lsRemote };
			if (key === "gh auth status") return { ok: true, out: "" };
			if (key.startsWith("gh release view")) return { ok: releaseExists, out: "" };
			throw new Error(`unexpected ${key}`);
		};
		return { capture, seen };
	}

	it("refuses when the remote tag points at another commit", () => {
		const r = runner(`${OTHER}\trefs/tags/v0.4.1\n`);
		assert.throws(() => publishPreflight(r.capture, { tag: "v0.4.1", repo: "bbMisk/learnharness" }), /points at b{40}, not HEAD/);
		assert.ok(!r.seen.some((k) => k.startsWith("gh release")), "stops before touching releases");
	});

	it("uses the peeled commit of an annotated tag", () => {
		assert.equal(remoteTagCommit(`${OTHER}\trefs/tags/v1.0.0\n${HEAD}\trefs/tags/v1.0.0^{}\n`, "v1.0.0"), HEAD);
		assert.equal(publishPreflight(runner(`${OTHER}\trefs/tags/v1.0.0\n${HEAD}\trefs/tags/v1.0.0^{}\n`).capture, { tag: "v1.0.0", repo: "r/r" }), HEAD);
	});

	it("accepts a missing tag or one at HEAD", () => {
		assert.equal(publishPreflight(runner("").capture, { tag: "v0.4.1", repo: "r/r" }), HEAD);
		assert.equal(publishPreflight(runner(`${HEAD}\trefs/tags/v0.4.1\n`).capture, { tag: "v0.4.1", repo: "r/r" }), HEAD);
	});

	it("still refuses an existing release, and an unreadable tag list", () => {
		assert.throws(() => publishPreflight(runner("", { releaseExists: true }).capture, { tag: "v0.4.1", repo: "r/r" }), /already exists/);
		const bad = runner("");
		const failing = (cmd: string, args: string[]) => (args[0] === "ls-remote" ? { ok: false, out: "" } : bad.capture(cmd, args));
		assert.throws(() => publishPreflight(failing, { tag: "v0.4.1", repo: "r/r" }), /could not read tags/);
	});
});

describe("active check interval reaches Settings (fix 6)", () => {
	it("main.cjs reports 4 hours for self-updating builds and 24 otherwise", () => {
		const file = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
		const mainRequire = createRequire(file);
		for (const [flag, hours] of [[true, 4], [false, 24]] as const) {
			const context = {
				require: (id: string) => {
					if (id === "electron") return { app: { isPackaged: true, setName() {}, getPath: () => "/fixture-user-data", getVersion: () => "0.4.0", requestSingleInstanceLock: () => false, quit() {}, on() {} }, dialog: { showMessageBox() {} }, BrowserWindow: { getAllWindows: () => [] } };
					if (id === "node:fs") return { existsSync: () => true, mkdirSync() {}, appendFileSync() {} };
					if (id === "electron-updater") return { autoUpdater: { on() {} } };
					if (id === "../package.json") return { version: "0.4.0", ...(flag ? { lhMacUpdater: "self" } : {}) };
					return mainRequire(id);
				},
				process: { platform: "darwin", resourcesPath: "/fixture/Resources", execPath: "/fixture/LearnHarness.app/Contents/MacOS/LearnHarness", argv: [], env: {}, on() {} },
				console: { log() {} }, __dirname: path.dirname(file),
			};
			runInNewContext(readFileSync(file, "utf8"), context, { filename: file });
			runInNewContext("setupAutoUpdater(); reportUpdateStatus('checking')", context);
			assert.equal(runInNewContext("updateState.checkHours", context), hours);
		}
	});
});
