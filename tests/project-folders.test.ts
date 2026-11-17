import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// Live-linked project folders (owner 2026-11-17): a project stores a folder's
// path, never its bytes; the agent sees it in the project prompt, and
// restricted File access keeps it readable. Synthetic locations only.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lh-project-folders-")));
const home = path.join(root, "home");
const data = path.join(root, "data");
const auth = path.join(root, "auth.json");
const notes = path.join(home, "Course Notes");
const other = path.join(root, "Other");
const prior = Object.fromEntries(["HOME", "USERPROFILE", "LH_AUTH_FILE", "LH_DATA_DIR"].map((key) => [key, process.env[key]]));
Object.assign(process.env, { HOME: home, USERPROFILE: home, LH_AUTH_FILE: auth, LH_DATA_DIR: data });
for (const directory of [notes, other, data]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(auth, "{}\n");
await fs.writeFile(path.join(notes, "week1.md"), "synthetic week 1\n");
await fs.writeFile(path.join(other, "secret.md"), "synthetic other\n");
const { SETTINGS_FILE } = await import("../config.ts");
const { projectStore, projectView, projectInstructions, checkProjectFolder } = await import("../src/server/projects.ts");
const { fileAccessPolicy } = await import("../src/server/file-access.ts");
const { setFileAccessPolicy } = await import("../src/agent/tools/file-access.ts");
const { resolveSourcePath } = await import("../src/agent/tools/fs-shared.ts");
const project = await import("../app/api/projects/[id]/route.ts");
const put = (id: string, body: object) =>
	project.PUT(new Request("http://test/api", { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
beforeEach(async () => {
	await fs.rm(SETTINGS_FILE, { force: true });
	setFileAccessPolicy(fileAccessPolicy);
});
after(async () => {
	setFileAccessPolicy(() => ({ restricted: false, folders: [] }));
	for (const [key, value] of Object.entries(prior)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fs.rm(root, { recursive: true, force: true });
});

describe("project folders", () => {
	it("links, lists, prompts and removes a folder without copying it", async () => {
		const p = projectStore.create("Folders");
		const added = await put(p.id, { addFolders: [notes + "/"] });
		assert.equal(added.status, 200);
		const view = await added.json();
		assert.deepEqual(view.folders, [notes], "stored normalized, without the trailing separator");
		assert.deepEqual(view.linkedFolders, [{ path: notes, name: "Course Notes", available: true }]);
		assert.deepEqual(view.fileIds, [], "a folder is not an upload");
		await assert.rejects(fs.access(path.join(data, "uploads")), "nothing is copied into the upload store");
		const prompt = await projectInstructions(p.id);
		assert.match(prompt, /Shared project folders, linked live/);
		assert.ok(prompt.includes(`- Course Notes/: ${JSON.stringify(notes)}`));
		const removed = await put(p.id, { removeFolders: [notes] });
		assert.equal(removed.status, 200);
		assert.deepEqual((await removed.json()).linkedFolders, []);
		assert.doesNotMatch(await projectInstructions(p.id), /project folders/);
	});

	it("refuses relative paths, files, missing folders, the data folder and duplicates", async () => {
		const p = projectStore.create("Refusals");
		assert.equal((await put(p.id, { addFolders: [notes] })).status, 200);
		for (const [folder, message] of [
			["Course Notes", /on this computer/],
			[path.join(notes, "week1.md"), /a file, not a folder/],
			[path.join(root, "missing"), /doesn't exist/],
			[data, /LearnHarness's own data/],
			[path.join(data, "projects"), /LearnHarness's own data/],
			[notes, /already in this project/],
			[path.join(notes, "..", "Course Notes"), /already in this project/],
		] as const) {
			const response = await put(p.id, { addFolders: [folder] });
			assert.equal(response.status, 400, folder);
			assert.match((await response.json()).error, message, folder);
		}
		assert.equal((await put(p.id, { addFolders: "nope" })).status, 400);
		assert.equal((await put(p.id, { folders: [] })).status, 400, "whole-list replacement is refused like fileIds");
		assert.deepEqual(projectStore.get(p.id)!.folders, [notes]);
		assert.ok("error" in checkProjectFolder(42, []));
	});

	it("keeps a project usable when a linked folder disappears", async () => {
		const gone = path.join(root, "Gone");
		await fs.mkdir(gone);
		const p = projectStore.create("Vanishing");
		assert.equal((await put(p.id, { addFolders: [gone] })).status, 200);
		await fs.rm(gone, { recursive: true });
		const view = (await projectView(p.id))!;
		assert.deepEqual(view.linkedFolders, [{ path: gone, name: "Gone", available: false }]);
		const prompt = await projectInstructions(p.id);
		assert.match(prompt, /missing or unreadable/);
		assert.doesNotMatch(prompt, /linked live/);
		assert.equal((await put(p.id, { removeFolders: [gone] })).status, 200, "a missing folder can still be removed");
	});

	it("loads projects saved before folders existed", async () => {
		const p = projectStore.create("Legacy");
		const file = path.join(data, "projects", p.id + ".json");
		const { folders: _dropped, ...legacy } = JSON.parse(await fs.readFile(file, "utf8"));
		await fs.writeFile(file, JSON.stringify(legacy));
		const view = (await projectView(p.id))!;
		assert.deepEqual(view.folders, []);
		assert.deepEqual(view.linkedFolders, []);
		assert.equal((await put(p.id, { instructions: "x", expected: { instructions: "" } })).status, 200);
		assert.deepEqual(projectStore.get(p.id)!.folders, []);
	});

	it("restricted File access keeps linked project folders readable, and only those", async () => {
		const reading = path.join(home, "Reading");
		await fs.mkdir(reading);
		await fs.writeFile(path.join(reading, "paper.md"), "synthetic paper\n");
		const p = projectStore.create("Restricted");
		assert.equal((await put(p.id, { addFolders: [reading] })).status, 200);
		await fs.writeFile(SETTINGS_FILE, JSON.stringify({ version: 1, agent: { fileAccess: { restricted: true, folders: [] } } }));
		assert.equal(resolveSourcePath(path.join(reading, "paper.md")), path.join(reading, "paper.md"));
		assert.throws(() => resolveSourcePath(path.join(other, "secret.md")), /allowed folders/);
		assert.equal((await put(p.id, { removeFolders: [reading] })).status, 200);
		assert.throws(() => resolveSourcePath(path.join(reading, "paper.md")), /allowed folders/, "unlinking revokes access");
		assert.ok(!fileAccessPolicy().folders.includes(reading));
		await fs.writeFile(SETTINGS_FILE, JSON.stringify({ version: 1, agent: { fileAccess: { restricted: false, folders: [] } } }));
		assert.ok(!fileAccessPolicy().folders.includes(notes), "unrestricted mode lists no folders");
	});
});
