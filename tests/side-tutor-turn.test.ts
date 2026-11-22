/**
 * FORK: under the default side-chat switch ("tutor") a turn does no
 * side-question work: the model receives exactly what it received at
 * 4f297a67 for the same lesson and input, the chat store's record read runs
 * as often, and side threads a record already carries (only possible after
 * "questions" mode) stay as they are — kept on disk, never delivered.
 * tests/fixtures/side-tutor-turn-baseline.json is tests/helpers/side-tutor-turn.ts
 * run in an export of 4f297a67.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-side-tutor-turn-"));
process.env.LH_DATA_DIR = scratch;
delete process.env.LH_FORK_SIDE_CHAT;
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const baseline = JSON.parse(fs.readFileSync(new URL("./fixtures/side-tutor-turn-baseline.json", import.meta.url), "utf8")) as { requests: unknown; storeReads: number };
const { forkSideChat } = await import("../src/core/fork-config.ts");
const { PATHS } = await import("../config.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { captureTurn, lessonMessages, seedLesson } = await import("./helpers/side-tutor-turn.ts");

type Disk = { sideChats?: unknown; messages: Array<{ id: string; role: string; customType?: string; content?: unknown }> };
const onDisk = (id: string) => JSON.parse(fs.readFileSync(path.join(PATHS.chats, `${id}.json`), "utf8")) as Disk;
const sideMarkers = (record: Disk) => record.messages.filter((m) => m.role === "custom" && (m.customType === "side-question" || m.customType === "side-question-told"));
const at = "2026-11-20T00:00:00Z";
const thread = {
	id: "side_saved", anchor: { messageId: "a0", partId: "a0-t0", blockIndex: 0, blockText: "A limit is the value a function approaches." }, open: false, createdAt: at,
	messages: [
		{ id: "sq1", role: "user" as const, text: "Is a limit the same as the value?", at },
		{ id: "sa1", role: "assistant" as const, text: "Not always: the function need not reach it.", at },
	],
};

describe("a turn under the default switch does no side-question work", () => {
	it("runs in the side tutor mode", () => assert.equal(forkSideChat, "tutor"));

	it("(a) sends the pre-slice request and reads the record as often, with no side hooks installed", async () => {
		const result = await captureTurn(seedLesson());
		assert.deepEqual(result.requests, baseline.requests, "system prompt, messages and tools as at 4f297a67");
		assert.equal(result.storeReads, baseline.storeReads, "record reads during the turn as at 4f297a67");
		assert.deepEqual(result.hooks, { contextUpdates: false, validateContext: false });
	});

	it("(b) leaves undelivered side threads alone: nothing injected, no markers written, sideChats unchanged on disk", async () => {
		const chatId = seedLesson();
		chatStore.updateSideChats(chatId, () => [thread]);
		const before = onDisk(chatId).sideChats;
		const result = await captureTurn(chatId);
		assert.deepEqual(result.requests, baseline.requests, "the saved thread reaches the model nowhere");
		assert.equal(result.storeReads, baseline.storeReads);
		const record = onDisk(chatId);
		assert.deepEqual(record.sideChats, before);
		assert.equal(sideMarkers(record).length, 0);
	});

	it("(b) still sends side history the record already carries, and adds none", async () => {
		const marker = {
			id: "exchange_side_saved_update_1", role: "custom", customType: "side-question", display: false, timestamp: 3,
			content: "Recorded learner–helper conversation update\nConversation: side_saved\n\nLearner:\nIs a limit the same as the value?\n\nEnd of recorded learner–helper conversation update.",
			details: { threadId: "side_saved", updates: [thread.messages[0]] },
		};
		const chatId = seedLesson([...lessonMessages(), marker]);
		chatStore.updateSideChats(chatId, () => [thread]);
		const result = await captureTurn(chatId);
		assert.match(JSON.stringify(result.requests), /Is a limit the same as the value\?/, "existing history is still history");
		assert.doesNotMatch(JSON.stringify(result.requests), /Not always: the function need not reach it/, "the undelivered reply is not delivered");
		assert.deepEqual(sideMarkers(onDisk(chatId)).map((m) => m.id), [marker.id]);
	});

	it("(d) under \"questions\" the side hooks are installed", () => {
		const helper = fileURLToPath(new URL("./helpers/side-tutor-turn.ts", import.meta.url));
		const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", LH_FORK_SIDE_CHAT: "questions", LH_DATA_DIR: fs.mkdtempSync(path.join(scratch, "questions-")) };
		const run = spawnSync(process.execPath, ["--import", "tsx", helper], { env, encoding: "utf8", timeout: 120_000 });
		assert.equal(run.status, 0, run.stderr);
		const result = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as { hooks: { contextUpdates: boolean; validateContext: boolean } };
		assert.deepEqual(result.hooks, { contextUpdates: true, validateContext: true });
	});
});
