/** Stored chat titles and project names are one line of at most 200 characters (QA low: titles had no cap and kept control characters). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-title-limits-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
const { chatStore } = await import("../src/store/chats.ts");
const { projectStore } = await import("../src/store/projects.ts");
const chatRoute = await import("../app/api/chats/[id]/route.ts");
const projectsRoute = await import("../app/api/projects/route.ts");
const projectRoute = await import("../app/api/projects/[id]/route.ts");
after(() => fs.rmSync(root, { recursive: true, force: true }));

it("chat titles drop control characters and stop at 200 characters, on create and rename", async () => {
	const chat = chatStore.createChat("Line one\nline\u0000two\u0007");
	assert.equal(chatStore.getChat(chat.id)!.title, "Line one line two");
	const response = await chatRoute.PUT(
		new Request("http://test/api", { method: "PUT", body: JSON.stringify({ title: "é".repeat(200_000) }) }),
		{ params: Promise.resolve({ id: chat.id }) },
	);
	assert.equal(response.status, 200);
	assert.equal(chatStore.getChat(chat.id)!.title, "é".repeat(200));
	chatStore.renameChat(chat.id, "🧮".repeat(250));
	assert.equal(Array.from(chatStore.getChat(chat.id)!.title).length, 200, "the cap counts characters, not UTF-16 units");
	chatStore.renameChat(chat.id, "\n\t\u0001");
	assert.equal(chatStore.getChat(chat.id)!.title, "Untitled session");
});

it("project names get the same cleanup", () => {
	const project = projectStore.create("Linear\r\nAlgebra");
	assert.equal(project.name, "Linear Algebra");
	assert.equal(projectStore.update(project.id, { name: "x\u001b[31m" }).name, "x [31m");
});

it("bidi controls are dropped from titles and project names", () => {
	const chat = chatStore.createChat("abc\u202Edef\u2066g\u2069\u200Fh");
	assert.equal(chatStore.getChat(chat.id)!.title, "abcdefgh");
	assert.equal(projectStore.create("\u202Egnp.exe").name, "gnp.exe");
	assert.equal(chatStore.renameChat(chat.id, "\u202E\u2067").title, "Untitled session");
});

it("an over-long project name says it is too long, on create and rename", async () => {
	const post = await projectsRoute.POST(new Request("http://test/api", { method: "POST", body: JSON.stringify({ name: "p".repeat(201) }) }));
	assert.equal(post.status, 400);
	assert.match(((await post.json()) as { error: string }).error, /at most 200 characters/);
	const project = projectStore.create("Short");
	const put = await projectRoute.PUT(
		new Request("http://test/api", { method: "PUT", body: JSON.stringify({ name: "p".repeat(250), expected: { name: "Short" } }) }),
		{ params: Promise.resolve({ id: project.id }) },
	);
	assert.equal(put.status, 400);
	assert.match(((await put.json()) as { error: string }).error, /at most 200 characters/);
});
