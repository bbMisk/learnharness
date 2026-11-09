import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";
import { checkNewFolder } from "../src/server/file-access.ts";

// The Settings check before a folder is listed: real disk, temp folders only.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lh-folder-check-")));
const home = path.join(root, "home");
const data = path.join(home, "Library", "LearnHarness");
const notes = path.join(home, "notes");
await fs.mkdir(data, { recursive: true });
await fs.mkdir(notes, { recursive: true });
await fs.symlink(notes, path.join(root, "notes-link"));
after(async () => { await fs.rm(root, { recursive: true, force: true }); });

it("refuses the app's own data folder and anything inside it", () => {
	assert.equal(checkNewFolder(data, [], data, home).error, "That is LearnHarness's own data folder.");
	assert.equal(checkNewFolder("~/Library/LearnHarness/chats", [], data, home).error, "That is LearnHarness's own data folder.");
	assert.deepEqual(checkNewFolder("~/Library", [], data, home), {}, "a parent of the data folder is a normal folder");
});

it("refuses a second spelling of a listed folder through a symlink", () => {
	assert.equal(checkNewFolder(path.join(root, "notes-link"), ["~/notes"], data, home).error, "That folder is already listed.");
	assert.deepEqual(checkNewFolder("~/notes", [], data, home), {});
});

it("lists a missing folder with a warning", () => {
	const missing = checkNewFolder("~/not-yet", [], data, home);
	assert.equal(missing.error, undefined);
	assert.equal(missing.warning, "Added, but that folder doesn't exist yet.");
});
