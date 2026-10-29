import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learning-history-"));
process.env.LH_DATA_DIR = temp;
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { graphSnapshot } = await import("../src/core/graph.ts");
after(() => fs.rmSync(temp, { recursive: true, force: true }));

it("persists learning history once and preserves it across transcript replacement and settings saves", () => {
	const chat = chatStore.createChat("History fixture");
	const messages = [{ id: "m1", role: "assistant", content: [{ type: "toolCall", id: "q1", name: "recall", arguments: { question: "Why?" } }], timestamp: 1000 } as unknown as LhMessage];
	chatStore.saveMessages(chat.id, messages);
	chatStore.saveMessages(chat.id, messages);
	chatStore.saveMessages(chat.id, []);
	chatStore.saveSettings(chat.id, {});
	const stored = chatStore.getChat(chat.id) as unknown as { learningEvents?: { itemId: string }[] };
	assert.equal(stored.learningEvents?.length, 1);
	assert.equal(stored.learningEvents![0]!.itemId, "q1");
	assert.equal("learningEvents" in chatStore.listChats()[0]!, false, "sidebar summaries must not carry the full log");
});

it("uses a human source label without changing its path and retains it on reimport", () => {
	const source = { id: "src_notes", filePath: "/notes/exam-123.md", importedAt: "2026-01-01T00:00:00.000Z" };
	graphStore.upsertSource({ ...source, displayName: "Regression & regularization" } as typeof source);
	for (let i = 0; i < 3; i++) graphStore.appendNode({ id: `n${i}`, name: "Concept", statement: "A true statement", aliases: [], createdAt: source.importedAt, provenance: [{ chatId: source.id, messageId: "" }] });
	graphStore.upsertSource({ ...source, importedAt: "2026-02-01T00:00:00.000Z" });
	const snapshot = graphSnapshot({ chatStore, graphStore });
	assert.equal(snapshot.clusters.find(c => c.id === source.id)?.label, "Regression & regularization");
	assert.equal(snapshot.fileSources[source.id], "/notes/exam-123.md");
});
