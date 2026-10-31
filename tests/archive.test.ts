import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-archive-"));
process.env.LH_DATA_DIR = directory;
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
const { chatStore, setChatOrganization } = await import("../src/store/chats.ts");
const { projectStore } = await import("../src/store/projects.ts");
const { subscribe } = await import("../src/core/events.ts");
const route = await import("../app/api/chats/[id]/route.ts");
const listing = await import("../app/api/chats/route.ts");
after(() => fs.rmSync(directory, { recursive: true, force: true }));
const request = (body: unknown) => new Request("http://test/api/chats/fixture", { method: "PUT", body: JSON.stringify(body) });

it("archives and restores a chat without changing its lesson, progress, activity date, pin, or project", async () => {
	const project = projectStore.create("Course notes");
	const chat = chatStore.createChat("Finished lesson");
	chatStore.saveMessages(chat.id, [{ id: "user-1", role: "user", content: "Keep my work.", timestamp: 1 }]);
	chatStore.saveSettings(chat.id, { model: { provider: "fixture", id: "model" }, thinkingLevel: "high" });
	chatStore.saveTree(chat.id, { nodes: [], edges: [], version: 1 });
	chatStore.appendTurnUsage(chat.id, { id: "turn-1", messageId: "user-1", model: "fixture:model", at: "2026-10-01T00:00:00.000Z", steps: [] });
	setChatOrganization(chat.id, { pinned: true, projectId: project.id });
	const before = chatStore.getChat(chat.id)!;
	const context = { params: Promise.resolve({ id: chat.id }) };
	let notifications = 0;
	const off = subscribe(event => { if (event.type === "chats-changed") notifications++; });
	try {
		assert.equal((await route.PUT(request({ archived: true }), context)).status, 200);
		assert.deepEqual(chatStore.getChat(chat.id), { ...before, archived: true });
		assert.equal(notifications, 1, "other Macs must receive the organization change");
		const summary = (await (await listing.GET()).json()).chats.find((item: { id: string }) => item.id === chat.id);
		assert.equal(summary.archived, true);
		assert.equal(summary.pinned, true);
		assert.equal(summary.projectId, project.id);
		assert.equal((await route.GET(new Request("http://test"), context)).status, 200, "archiving keeps direct links readable");
		chatStore.saveMessages(chat.id, [...before.messages, { id: "user-2", role: "user", content: "More work.", timestamp: 2 }]);
		const continued = chatStore.getChat(chat.id)!;
		assert.equal(continued.archived, true, "normal persistence must retain the archive flag");
		assert.equal((await route.PUT(request({ archived: false }), context)).status, 200);
		assert.deepEqual(chatStore.getChat(chat.id), { ...continued, archived: false });
		assert.equal(notifications, 2);
	} finally { off(); }
});

it("rejects malformed archive changes before applying any accompanying edits", async () => {
	const chat = chatStore.createChat("Keep this title");
	const context = { params: Promise.resolve({ id: chat.id }) };
	const before = chatStore.getChat(chat.id);
	for (const archived of ["true", 1, null, {}, []]) {
		assert.equal((await route.PUT(request({ archived, title: "Changed" }), context)).status, 400);
		assert.deepEqual(chatStore.getChat(chat.id), before);
	}
	assert.equal((await route.PUT(request({ archived: true }), { params: Promise.resolve({ id: "chat_missing" }) })).status, 404);
});

it("moves existing chats between projects and back out while retaining archive, pin and lesson state", async () => {
	const first = projectStore.create("First project"), second = projectStore.create("Second project");
	const { projectInstructions } = await import("../src/server/projects.ts");
	projectStore.update(first.id, { instructions: "FIRST_PROJECT_CONTEXT" });
	projectStore.update(second.id, { instructions: "SECOND_PROJECT_CONTEXT" });
	const chat = chatStore.createChat("Existing chat");
	chatStore.saveMessages(chat.id, [{ id: "user", role: "user", content: "Existing lesson.", timestamp: 1 }]);
	setChatOrganization(chat.id, { pinned: true, archived: true });
	const original = chatStore.getChat(chat.id)!;
	const context = { params: Promise.resolve({ id: chat.id }) };
	for (const projectId of [first.id, second.id, null]) {
		assert.equal((await route.PUT(request({ projectId }), context)).status, 200);
		const current = chatStore.getChat(chat.id)!;
		assert.deepEqual(current, projectId === null ? original : { ...original, projectId });
		const instructions = await projectInstructions(current.projectId);
		if (projectId === first.id) assert.match(instructions, /FIRST_PROJECT_CONTEXT/);
		if (projectId === second.id) { assert.match(instructions, /SECOND_PROJECT_CONTEXT/); assert.doesNotMatch(instructions, /FIRST_PROJECT_CONTEXT/); }
		if (projectId === null) assert.equal(instructions, "");
	}
});
