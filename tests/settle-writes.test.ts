/**
 * One record write per settled reply: the turn's messages and its usage
 * entry land in ONE atomic write (they used to be two full read-modify-
 * write cycles — saveMessages, then appendTurnUsage), the result is the
 * record the two-step path produced, and a usage failure still saves the
 * messages.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it, mock } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-settle-writes-"));
process.env.LH_DATA_DIR = root;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";
const { PATHS } = await import("../config.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { persistSettledTurn, persistTurn } = await import("../src/server/turn-service.ts");
type LhMessage = import("../src/core/native-messages.ts").LhMessage;
type TurnUsage = import("../src/core/contracts.ts").TurnUsage;
type ChatRecord = import("../src/core/contracts.ts").ChatRecord;
after(() => fs.rmSync(root, { recursive: true, force: true }));

const chatFile = (id: string) => path.join(PATHS.chats, `${id}.json`);

/** Count completed atomic writes (the rename that lands each one) per file. */
function countWrites(file: string): { readonly count: number } {
	const rename = fs.renameSync;
	const counter = { count: 0 };
	mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
		rename(from, to);
		if (path.resolve(String(to)) === path.resolve(file)) counter.count++;
	});
	return counter;
}

const step = { inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 };

/** The record minus what legitimately differs between two chats or two writes. */
function comparable(record: ChatRecord | null): Record<string, unknown> {
	assert.ok(record);
	const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = record;
	return rest;
}

describe("reply settlement writes", () => {
	it("a settled turn writes the chat record once (messages + usage together)", async () => {
		const faux = createFauxCore({});
		faux.setResponses([() => fauxAssistantMessage([fauxText("Settled reply")])]);
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const chat = chatStore.createChat("Settle writes");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		const total = countWrites(chatFile(chat.id));
		let atAgentBuild = -1;
		try {
			const ack = await handleChatRequest(new Request("http://test/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "go" } }),
			}), (opts) => {
				// Built after the write-ahead persist: every write from here on
				// belongs to the settlement.
				atAgentBuild = total.count;
				return createTeacherAgent(undefined, { engine, messages: opts.messages, onUsage: opts.onUsage });
			});
			assert.equal(ack.status, 200);
			const handle = runningTurn(chat.id);
			if (handle) await new Response(handle.subscribe()).text();
		} finally { mock.restoreAll(); }
		assert.equal(atAgentBuild, 1, "the write-ahead persist is its own write, before the run");
		assert.equal(total.count - atAgentBuild, 1, "settlement: one write (was two: messages, then usage)");
		const saved = chatStore.getChat(chat.id)!;
		const reply = saved.messages.find((m) => m.role === "assistant");
		assert.ok(reply && JSON.stringify(reply.content).includes("Settled reply"));
		assert.equal(saved.turns?.length, 1);
		assert.equal(saved.turns![0]!.messageId, reply.id, "usage provenance is the turn's first assistant message");
		assert.equal(saved.turns![0]!.model, "openrouter:z-ai/glm-5.3-flash");
	});

	it("the one-write record equals the old two-step result (persistTurn, then appendTurnUsage)", () => {
		const prior: TurnUsage = { id: "turn_prior", messageId: "m_prior", at: "2026-10-01T00:00:00.000Z", model: "openai:gpt-5", steps: [step] };
		const base = [
			{ id: "u1", role: "user", content: "hello", timestamp: 1 },
			{ id: "m_prior", role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
			{ id: "u2", role: "user", content: "more", timestamp: 3 },
		] as unknown as LhMessage[];
		const turn = [
			...base,
			{ id: "a2", role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: 4 },
		] as unknown as LhMessage[];
		for (const entryId of ["turn_new", "turn_prior"]) { // a fresh entry, and a replay the log already holds
			const entry: TurnUsage = { id: entryId, messageId: "a2", at: "2026-10-02T00:00:00.000Z", model: "openai:gpt-5", steps: [step, step] };
			const twins = [chatStore.createChat("Twin"), chatStore.createChat("Twin")];
			for (const twin of twins) {
				chatStore.saveMessages(twin.id, base);
				chatStore.appendTurnUsage(twin.id, prior);
			}
			const [oldWay, newWay] = twins as [ChatRecord, ChatRecord];

			const oldWrites = countWrites(chatFile(oldWay.id));
			const stampedOld = persistTurn(chatStore, oldWay.id, base.length, turn, false);
			chatStore.appendTurnUsage(oldWay.id, { ...entry, messageId: stampedOld.find((m) => m.role === "assistant")!.id });
			mock.restoreAll();

			const newWrites = countWrites(chatFile(newWay.id));
			const { stamped, usageError } = persistSettledTurn(chatStore, newWay.id, base.length, turn, false, (saved) => ({ ...entry, messageId: saved.find((m) => m.role === "assistant")!.id }));
			mock.restoreAll();

			assert.equal(oldWrites.count, 2, "before: two full writes per settled turn");
			assert.equal(newWrites.count, 1, "after: one");
			assert.equal(usageError, undefined);
			assert.deepEqual(stamped, stampedOld);
			assert.deepEqual(comparable(chatStore.getChat(newWay.id)), comparable(chatStore.getChat(oldWay.id)));
			assert.deepEqual(
				comparable(JSON.parse(fs.readFileSync(chatFile(newWay.id), "utf8"))),
				comparable(JSON.parse(fs.readFileSync(chatFile(oldWay.id), "utf8"))),
				"the bytes on disk match too, timestamps aside",
			);
			assert.equal(chatStore.getChat(newWay.id)!.turns!.length, entryId === "turn_prior" ? 1 : 2, "idempotent per turn id");
		}
	});

	it("no usage to log is a single plain messages write", () => {
		const chat = chatStore.createChat("No usage");
		const writes = countWrites(chatFile(chat.id));
		const turn = [{ id: "u1", role: "user", content: "hi", timestamp: 1 }] as unknown as LhMessage[];
		const { usageError } = persistSettledTurn(chatStore, chat.id, 0, turn, false, () => undefined);
		mock.restoreAll();
		assert.equal(writes.count, 1);
		assert.equal(usageError, undefined);
		assert.equal(chatStore.getChat(chat.id)!.turns, undefined);
	});

	it("a usage failure still saves the messages and comes back as usageError", () => {
		const turn = [
			{ id: "u1", role: "user", content: "hi", timestamp: 1 },
			{ id: "a1", role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: 2 },
		] as unknown as LhMessage[];
		const entry: TurnUsage = { id: "t1", messageId: "a1", at: "x", model: "openai:gpt-5", steps: [step] };

		// The entry cannot be built: the messages save alone.
		const built = chatStore.createChat("Usage build fails");
		const builtWrites = countWrites(chatFile(built.id));
		const buildFailure = new Error("usage build failed");
		const first = persistSettledTurn(chatStore, built.id, 0, turn, false, () => { throw buildFailure; });
		mock.restoreAll();
		assert.equal(first.usageError, buildFailure);
		assert.equal(builtWrites.count, 1);
		assert.deepEqual(chatStore.getChat(built.id)!.messages.map((m) => m.id), ["u1", "a1"]);
		assert.equal(chatStore.getChat(built.id)!.turns, undefined);

		// The combined write fails: the messages are retried alone and land.
		const combined = chatStore.createChat("Combined write fails");
		const save = chatStore.saveMessages;
		const writeFailure = new Error("combined write failed");
		chatStore.saveMessages = (id, messages, usage) => {
			if (usage) throw writeFailure;
			save(id, messages);
		};
		try {
			const second = persistSettledTurn(chatStore, combined.id, 0, turn, false, () => entry);
			assert.equal(second.usageError, writeFailure);
		} finally { chatStore.saveMessages = save; }
		assert.deepEqual(chatStore.getChat(combined.id)!.messages.map((m) => m.id), ["u1", "a1"]);
		assert.equal(chatStore.getChat(combined.id)!.turns, undefined);

		// The messages themselves cannot be saved: the canonical failure throws.
		const lost = chatStore.createChat("Messages fail");
		chatStore.saveMessages = () => { throw new Error("disk gone"); };
		const quiet = mock.method(console, "error", () => {});
		try {
			assert.throws(() => persistSettledTurn(chatStore, lost.id, 0, turn, false, () => entry), /The reply could not be saved\./);
		} finally { chatStore.saveMessages = save; quiet.mock.restore(); }
		assert.deepEqual(chatStore.getChat(lost.id)!.messages, []);
	});
});
