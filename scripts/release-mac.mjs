#!/usr/bin/env node
/**
 * Unsigned macOS release (owner design, 2026-11-03): build on this Mac,
 * ad-hoc signed (no Developer ID, no notarization), for the in-app
 * self-updater (electron/mac-self-updater.cjs).
 *
 *   npm run release:mac               DRY RUN: build + verify + list what would upload
 *   npm run release:mac -- --publish  also create GitHub release v<version> and upload
 *
 * The release is a normal (non-draft, non-prerelease) release marked latest,
 * so /releases/latest/download/<asset> — the app's update feed and the
 * permanent LearnHarness-arm64.dmg link — point at it.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { parseFeed, verifyFile } = require("../electron/mac-self-updater.cjs");
const { publishPreflight } = await import("./release-mac-preflight.mjs");

const REPO = "bbMisk/learnharness";
const CONFIG = "electron-builder.unsigned-mac.yml";
const OUT = path.join(root, "dist", "release-mac");

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--publish");
if (unknown.length) fail(`unknown argument(s): ${unknown.join(" ")} (only --publish is accepted)`);
const publish = args.includes("--publish");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const tag = `v${version}`;

function fail(message) {
	console.error(`release:mac: ${message}`);
	process.exit(1);
}
function run(command, commandArgs, options = {}) {
	console.log(`\n$ ${[command, ...commandArgs].join(" ")}`);
	const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) fail(`${path.basename(command)} failed (${result.status ?? result.signal})`);
}
function capture(command, commandArgs) {
	const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8" });
	return { ok: !result.error && result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

if (process.platform !== "darwin" || process.arch !== "arm64") fail("build on an Apple Silicon Mac (darwin/arm64)");

// ── Publish preflight: fail before a long build, never after a partial upload.
let commit = null;
if (publish) {
	try {
		commit = publishPreflight(capture, { tag, repo: REPO });
	} catch (err) {
		fail(err.message);
	}
}

// ── Build (same payload steps as desktop:dist, Electron-runtime smoke like CI).
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(path.join(root, ".next", "standalone"), { recursive: true, force: true });
run("npm", ["run", "build"]);
run(process.execPath, ["scripts/build-server.mjs"]);
run(process.execPath, ["scripts/smoke-server.mjs", "--electron"]);

const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const hasActool = fs.existsSync(path.join(developerDir, "usr", "bin", "actool"));
const builderArgs = [require.resolve("electron-builder/cli.js"), "--mac", "--arm64", "--config", CONFIG, "--publish", "never"];
if (hasActool) builderArgs.push("--config.mac.icon=build/icon.icon");
else console.log("\nNote: Xcode's actool not found — using the flat build/icon.icns (no Liquid Glass icon).");
run(process.execPath, builderArgs, { env: { ...process.env, ...(hasActool ? { DEVELOPER_DIR: developerDir } : {}), CSC_IDENTITY_AUTO_DISCOVERY: "false" } });

// ── Collect + verify the artifacts.
const base = `LearnHarness-${version}-arm64`;
const dmg = path.join(OUT, `${base}.dmg`);
const zip = path.join(OUT, `${base}-mac.zip`);
const feedFile = path.join(OUT, "latest-mac.yml");
const permanentDmg = path.join(OUT, "LearnHarness-arm64.dmg");
const assets = [dmg, `${dmg}.blockmap`, zip, `${zip}.blockmap`, feedFile];
for (const file of assets) if (!fs.existsSync(file)) fail(`missing build output ${path.relative(root, file)}`);
fs.copyFileSync(dmg, permanentDmg);
assets.push(permanentDmg);

const appBundle = path.join(OUT, "mac-arm64", "LearnHarness.app");
const signature = capture("/usr/bin/codesign", ["-dv", "--verbose=2", appBundle]);
console.log(`\ncodesign -dv ${path.relative(root, appBundle)}:\n${signature.out}`);
if (!signature.ok || !/^Signature=adhoc$/m.test(signature.out)) fail("the app is not ad-hoc signed");
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appBundle]);
if (!fs.existsSync(path.join(appBundle, "Contents", "Resources", "app-update.yml"))) fail("app-update.yml missing from the bundle");
const packaged = JSON.parse(require("@electron/asar").extractFile(path.join(appBundle, "Contents", "Resources", "app.asar"), "package.json").toString("utf8"));
if (packaged.lhMacUpdater !== "self" || packaged.version !== version) fail("packaged package.json lacks the self-updater flag or the release version");

const feed = parseFeed(fs.readFileSync(feedFile, "utf8"));
if (feed.version !== version) fail(`latest-mac.yml says ${feed.version}, package.json says ${version}`);
if (feed.zip.url !== path.basename(zip)) fail(`latest-mac.yml points at ${feed.zip.url}, expected ${path.basename(zip)}`);
await verifyFile(zip, feed.zip);
console.log(`\nlatest-mac.yml: version ${feed.version}, zip ${feed.zip.url} — size and sha512 match`);

console.log(`\nAssets for ${REPO} release ${tag}:`);
for (const file of assets) console.log(`  ${path.basename(file).padEnd(44)} ${mb(fs.statSync(file).size).padStart(10)}`);

const notes = [
	`LearnHarness ${version} for macOS (Apple Silicon). Download LearnHarness-arm64.dmg and drag LearnHarness to Applications.`,
	"",
	"This build is not signed with an Apple Developer ID. The first time you open it, macOS may say it can't check the app: open System Settings → Privacy & Security and choose Open Anyway.",
	"Copies in Applications update themselves from now on.",
].join("\n");
const ghArgs = ["release", "create", tag, "--repo", REPO, "--target", commit ?? "<HEAD commit>", "--title", `LearnHarness ${version}`, "--notes", notes, "--latest", ...assets];

if (!publish) {
	console.log(`\nDRY RUN — nothing was uploaded. With --publish this would run:\n  gh ${ghArgs.map((a) => (/[\s<>]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
	console.log(`\nTo ship: npm run release:mac -- --publish`);
	process.exit(0);
}

run("gh", ghArgs);
console.log(`\nPublished ${tag}: https://github.com/${REPO}/releases/tag/${tag}`);
