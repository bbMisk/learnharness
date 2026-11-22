import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "node:test";

const require = createRequire(import.meta.url);
const forkConfig = require("../electron/fork-config.cjs");
const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");

it("upstream's startup announcements stay off in this fork, behind one hook in the shell", () => {
	assert.equal(forkConfig.startupAnnouncements, false);
	// The feed is only started when the fork switch allows it; the IPC handlers stay registered and answer null.
	assert.match(main, /if \(app\.isPackaged && !devUrl && require\("\.\/fork-config\.cjs"\)\.startupAnnouncements\) \{\s*const \{ dismissalStore, startMessages \} = require\("\.\/startup-messages\.cjs"\);/);
	assert.equal(main.match(/require\("\.\/startup-messages\.cjs"\)/g)?.length, 1, "no second, ungated start of the feed");
});
