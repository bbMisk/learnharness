/**
 * FORK: what reaches disk and the model while the side tutor is the
 * switched-on side conversation (src/core/fork-config.ts), and the staged
 * chat file version: reads accept upstream's version 2, writes stamp 1.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, type TranscriptContext } from "@earendil-works/pi-ai";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-side-tutor-data-"));
process.env.LH_DATA_DIR = scratch;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";
delete process.env.LH_FORK_SIDE_CHAT;
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { PATHS } = await import("../config.ts");
const { forkSideChat, READABLE_CHAT_VERSION } = await import("../src/core/fork-config.ts");
const { CURRENT_CHAT_VERSION } = await import("../src/core/contracts.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { sideTutorResponse } = await import("../src/server/side-tutor.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");

const fileOf = (id: string) => path.join(PATHS.chats, `${id}.json`);
const onDisk = (id: string) => JSON.parse(fs.readFileSync(fileOf(id), "utf8")) as Record<string, unknown> & { messages: Array<{ role: string; customType?: string }> };

describe("chat file version, stage one of two", () => {
	it("reads upstream's version 2, refuses a newer one, and still stamps 1", () => {
		assert.equal(CURRENT_CHAT_VERSION, 1);
		assert.equal(READABLE_CHAT_VERSION, 2);
		const base = chatStore.createChat("version base");
		assert.equal(onDisk(base.id).version, 1, "writes stamp 1");
		const thread = { id: "side_t1", anchor: { messageId: "m1", partId: "m1-t0", blockIndex: 0, blockText: "Prose" }, open: false, createdAt: "2026-11-01T00:00:00Z", messages: [] };
		const variants = {
			v2: { ...onDisk(base.id), id: "chat_v2", version: 2 },
			v2side: { ...onDisk(base.id), id: "chat_v2side", version: 2, sideChats: [thread] },
			v3: { ...onDisk(base.id), id: "chat_v3", version: 3 },
		};
		for (const record of Object.values(variants)) fs.writeFileSync(fileOf(record.id), JSON.stringify(record));
		assert.equal(chatStore.getChat("chat_v2")?.title, "version base");
		assert.deepEqual(chatStore.getChat("chat_v2side")?.sideChats, [thread]);
		const error = console.error;
		console.error = () => {};
		try { assert.equal(chatStore.getChat("chat_v3"), null, "a record newer than upstream's is refused"); }
		finally { console.error = error; }
		chatStore.renameChat("chat_v2", "renamed");
		assert.equal(onDisk("chat_v2").version, 1, "a rewrite stamps 1");
	});
});

describe("the side tutor writes no side-question data", () => {
	it("a normal turn and a side tutor exchange leave no sideChats or side markers, on disk or on the wire", async () => {
		assert.equal(forkSideChat, "tutor");
		const chat = chatStore.createChat("tutor data");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		const contexts: TranscriptContext[] = [];
		const faux = createFauxCore({});
		faux.setResponses([(context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage([fauxText("Derivatives measure change.")]); }]);
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const ack = await handleChatRequest(new Request("http://test/api/chat", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "Teach me derivatives" } }),
		}), (opts) => createTeacherAgent(undefined, { engine, messages: opts.messages }));
		assert.equal(ack.status, 200, await ack.clone().text());
		const handle = runningTurn(chat.id);
		if (handle) await new Response(handle.subscribe()).text();
		assert.equal(contexts.length, 1);

		const tutor = createFauxCore({});
		tutor.setResponses([fauxAssistantMessage([fauxText("A derivative is a rate.")])]);
		const side = await sideTutorResponse(new Request(`http://test/api/chats/${chat.id}/side`, {
			method: "POST",
			body: JSON.stringify({ snapshot: { context: "Derivatives measure change.", model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } }, messages: [{ role: "user", content: "What is a rate?" }] }),
		}), chat.id, { getChat: chatStore.getChat, settings: () => resolveSettings(null), keyPresent: () => true, refresh: async () => {}, engine: () => ({ model: tutor.getModel(), streamFn: tutor.streamSimple }) });
		assert.equal(side.status, 200);
		const frames = (await side.text()).trim().split("\n").map((line) => JSON.parse(line) as { type: string; text?: string });
		assert.equal(frames.filter((f) => f.type === "delta").map((f) => f.text).join(""), "A derivative is a rate.");

		const record = onDisk(chat.id);
		assert.equal("sideChats" in record, false);
		assert.equal(record.messages.some((m) => m.role === "custom" && (m.customType === "side-question" || m.customType === "side-question-told")), false);
		assert.ok(record.messages.some((m) => m.role === "assistant"), "the turn itself persisted");
		const wire = JSON.stringify(contexts);
		assert.doesNotMatch(wire, /side-question|learner–helper|LEARNER–HELPER/i);
	});
});
