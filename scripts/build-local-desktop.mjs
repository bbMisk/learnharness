/** Keep signed bundles outside file-provider-backed Documents folders. */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const output = fs.mkdtempSync(path.join(os.tmpdir(), "learnharness-native-"));
const cli = require.resolve("electron-builder/cli.js");
function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status ?? result.signal}).`);
}
run(process.execPath, [cli, "--mac", "--dir", "--arm64", "--config", "electron-builder.local.yml", `--config.directories.output=${output}`, "--publish", "never"]);
const app = path.join(output, "mac-arm64", "LearnHarness.app");
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
run(path.join(app, "Contents/MacOS/LearnHarness"), ["-e", "console.log('Local Electron runtime verified: ' + process.versions.electron)"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist/local-build.json"), JSON.stringify({ app, version: require("../package.json").version }, null, 2) + "\n");
console.log(`Local desktop app ready: ${app}\nInstall in /Applications after quitting the previous copy. Keep signed app bundles outside Documents.`);
