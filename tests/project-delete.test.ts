/** QA #16: projects can be deleted (their chats move to the unassigned list) and names are unique. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-project-delete-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
const { projectStore } = await import("../src/server/projects.ts");
const { chatStore, setChatOrganization } = await import("../src/store/chats.ts");
const projects = await import("../app/api/projects/route.ts");
const project = await import("../app/api/projects/[id]/route.ts");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: object) => new Request("http://test/api", { method: "POST", body: JSON.stringify(body) });

it("DELETE removes the project and moves its chats, archived ones too, to the unassigned list", async () => {
	const p = projectStore.create("Linear Algebra");
	const other = projectStore.create("Physics");
	const live = chatStore.createChat("Eigenvalues");
	const archived = chatStore.createChat("Old drill");
	const elsewhere = chatStore.createChat("Forces");
	setChatOrganization(live.id, { projectId: p.id });
	setChatOrganization(archived.id, { projectId: p.id, archived: true });
	setChatOrganization(elsewhere.id, { projectId: other.id });
	const response = await project.DELETE!(new Request("http://test/api", { method: "DELETE" }), params(p.id));
	assert.equal(response.status, 200);
	assert.equal(projectStore.get(p.id), null);
	assert.equal(chatStore.getChat(live.id)!.projectId, undefined);
	assert.equal(chatStore.getChat(archived.id)!.projectId, undefined);
	assert.equal(chatStore.getChat(archived.id)!.archived, true);
	assert.equal(chatStore.getChat(elsewhere.id)!.projectId, other.id, "other projects keep their chats");
	assert.equal((await project.DELETE!(new Request("http://test/api", { method: "DELETE" }), params(p.id))).status, 404);
});

it("a second project with the same name (any case) is refused, on create and rename", async () => {
	assert.equal((await projects.POST(post({ name: "Quant" }))).status, 201);
	const duplicate = await projects.POST(post({ name: "  quant " }));
	assert.equal(duplicate.status, 400);
	assert.match((await duplicate.json()).error, /already exists/);
	const second = projectStore.create("Stats");
	const rename = await project.PUT(new Request("http://test/api", { method: "PUT", body: JSON.stringify({ name: "QUANT", expected: { name: "Stats" } }) }), params(second.id));
	assert.equal(rename.status, 400);
	const self = await project.PUT(new Request("http://test/api", { method: "PUT", body: JSON.stringify({ name: "stats", expected: { name: "Stats" } }) }), params(second.id));
	assert.equal(self.status, 200, "a project may change the case of its own name");
});
