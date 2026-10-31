import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pricing-transport-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "empty-auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });
const { chatStore } = await import("../src/store/chats.ts");
const { GET } = await import("../app/api/chats/[id]/route.ts");
const { sessionCost } = await import("../src/server/pricing.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("chat GET supplies derived Pi costs without persisting dollars or changing native history", async () => {
	const record = chatStore.createChat("price projection fixture");
	chatStore.saveMessages(record.id, [{ id: "fixture-input", role: "user", content: "synthetic", timestamp: 1 }]);
	const step = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 70_000, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 500 };
	for (const [id, model] of [["api", "openrouter:openai/gpt-6.1-sol"], ["plan", "chatgpt:fixture"], ["unknown", "missing:fixture"]]) {
		chatStore.appendTurnUsage(record.id, { id: id!, model: model!, messageId: "fixture-input", at: "fixture", steps: [step] });
	}
	const file = path.join(scratch, "chats", `${record.id}.json`);
	const before = fs.readFileSync(file, "utf8");
	const response = await GET(new Request(`http://localhost/api/chats/${record.id}`), { params: Promise.resolve({ id: record.id }) });
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body.messages, chatStore.getChat(record.id)!.messages);
	assert.deepEqual(body.pricing, sessionCost(chatStore.getChat(record.id)!));
	assert.equal(body.pricing.cost, 0.037);
	assert.equal(body.pricing.subscription, 1);
	assert.equal(body.pricing.unpriced, 1);
	assert.deepEqual(body.pricing.turnCosts, { api: 0.037, plan: null, unknown: null });
	assert.equal(fs.readFileSync(file, "utf8"), before, "read-time estimates must never rewrite the usage log");
});


test("chat detail reads one lesson snapshot for both history and coverage", async () => {
	const { fauxAssistantMessage } = await import("@earendil-works/pi-ai");
	const record = chatStore.createChat("single snapshot fixture");
	chatStore.saveMessages(record.id, [{ ...fauxAssistantMessage([{ type: "text", text: "A lesson paragraph." }]), id: "lesson" }]);
	const file = path.join(scratch, "chats", `${record.id}.json`);
	fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}\n`); // written elsewhere: the route's read goes to disk
	const read = fs.readFileSync;
	let reads = 0;
	const spy = mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
		if (String(args[0]) === file) reads++;
		return read(...args);
	});
	syncBuiltinESMExports();
	try {
		const response = await GET(new Request(`http://localhost/api/chats/${record.id}`), { params: Promise.resolve({ id: record.id }) });
		const body = await response.json();
		assert.equal(response.status, 200);
		assert.equal(body.coverage.totalMessages, 1);
		assert.equal(body.messages[0].content[0].text, "A lesson paragraph.");
		assert.equal(reads, 1, "coverage must reuse the lesson already read by the route");
	} finally { spy.mock.restore(); syncBuiltinESMExports(); }
});

test("chat detail retains its missing-lesson 404", async () => {
	const response = await GET(new Request("http://localhost/api/chats/missing"), { params: Promise.resolve({ id: "missing" }) });
	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), { error: "Not found" });
});

test("metadata-only chat reads equal the matching fields of the full read", async () => {
	const record = chatStore.createChat("metadata-only fixture");
	chatStore.saveMessages(record.id, [{ id: "meta-input", role: "user", content: "synthetic", timestamp: 1 }]);
	chatStore.appendTurnUsage(record.id, { id: "api", model: "openrouter:openai/gpt-6.1-sol", messageId: "meta-input", at: "fixture", steps: [{ inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 }] });
	const read = async (query: string) => (await GET(new Request(`http://localhost/api/chats/${record.id}${query}`), { params: Promise.resolve({ id: record.id }) })).json();
	const full = await read("");
	assert.deepEqual(await read("?only=stats"), { turns: full.turns, pricing: full.pricing });
	assert.deepEqual(await read("?only=coverage"), { coverage: full.coverage });
	assert.ok(Array.isArray(full.turns) && full.turns.length === 1, "fixture carries usage");
});
