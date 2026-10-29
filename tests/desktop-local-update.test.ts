import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { it } from "node:test";

const file = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
const source = readFileSync(file, "utf8");
const require = createRequire(file);

function updaterFixture(hasFeed: boolean) {
	const calls = { imports: 0, checks: 0, dialogs: [] as { message: string; detail: string }[] };
	const updater = { on() {}, checkForUpdates() { calls.checks++; return Promise.resolve({ updateInfo: { version: "1.0.0" } }); } };
	const context = {
		require: (id: string) => {
			if (id === "electron") return { app: { isPackaged: true, setName() {}, getPath: () => "/fixture", getVersion: () => "0.3.4-hanson.1", requestSingleInstanceLock: () => false, quit() {} }, dialog: { showMessageBox: (value: { message: string; detail: string }) => calls.dialogs.push(value) } };
			if (id === "node:fs") return { existsSync: () => hasFeed, mkdirSync() {}, appendFileSync() {} };
			if (id === "electron-updater") { calls.imports++; return { autoUpdater: updater }; }
			return require(id);
		},
		process: { platform: "darwin", resourcesPath: "/fixture/Resources", argv: [], env: {}, on() {} },
		console: { log() {} }, __dirname: dirname(file),
	};
	runInNewContext(source, context, { filename: file });
	return { calls, context };
}

it("a preview without an update feed cannot download updates and explains its update path", () => {
	const { calls, context } = updaterFixture(false);
	runInNewContext("setupAutoUpdater(); checkForUpdates({manual:true});", context);
	assert.equal(calls.imports, 0);
	assert.equal(calls.checks, 0);
	assert.equal(calls.dialogs[0]?.message, "Updates unavailable in this preview");
	assert.match(calls.dialogs[0]!.detail, /bbMisk\/learnharness/);
});

it("a packaged release with a feed uses the existing updater", async () => {
	const { calls, context } = updaterFixture(true);
	runInNewContext("setupAutoUpdater(); checkForUpdates();", context);
	await Promise.resolve();
	assert.equal(calls.imports, 1);
	assert.equal(calls.checks, 1);
	assert.equal(calls.dialogs.length, 0);
});
