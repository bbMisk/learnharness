import assert from "node:assert/strict";
import { it } from "node:test";

const mem = new Map<string, string>();
const localStorage = {
	get length() {
		return mem.size;
	},
	key: (i: number) => [...mem.keys()][i] ?? null,
	getItem: (k: string) => mem.get(k) ?? null,
	setItem: (k: string, v: string) => void mem.set(k, v),
	removeItem: (k: string) => void mem.delete(k),
};
(globalThis as Record<string, unknown>).window = { localStorage };
const { clearDraft, clearDrafts, readDraft, writeDraft } = await import("../components/draft-store.ts");
const { SessionModel } = await import("../components/session-core.ts");
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

it("saves after a pause, removes an emptied draft, and clears a chat's answered drafts", async () => {
	writeDraft("c:chat_1", "half-typed reply", 0);
	await pause();
	assert.equal(readDraft("c:chat_1"), "half-typed reply");
	writeDraft("c:chat_1", "", 0);
	await pause();
	assert.equal(readDraft("c:chat_1"), undefined);
	writeDraft("q:chat_1:a", { thinking: "x" }, 0);
	writeDraft("q:chat_1:b", { thinking: "y" }, 0);
	writeDraft("q:chat_2:c", { thinking: "z" }, 0);
	await pause();
	clearDrafts("q:chat_1:", "q:chat_1:b");
	assert.equal(readDraft("q:chat_1:a"), undefined);
	assert.deepEqual(readDraft("q:chat_1:b"), { thinking: "y" });
	assert.deepEqual(readDraft("q:chat_2:c"), { thinking: "z" }, "other chats keep theirs");
	clearDraft("q:chat_2:c");
	assert.equal(readDraft("q:chat_2:c"), undefined);
});

it("a question draft typed in one window comes back after a reload, selection included", async () => {
	const opts = { chatId: "chat_9", initialMessages: [], fetch: (() => new Promise<Response>(() => {})) as unknown as typeof fetch };
	const first = new SessionModel(opts as never);
	first.saveQuestionDraft("call_1", {
		form: {
			selection: { selected: new Set([2]), otherSelected: false, dontKnow: false },
			thinking: "because the image flips",
			other: "",
			text: "",
			confidenceIndex: 3,
		},
		readingThinking: "notes while reading",
	});
	await new Promise((resolve) => setTimeout(resolve, 350));
	const reloaded = new SessionModel(opts as never);
	const draft = reloaded.questionDraft("call_1")!;
	assert.equal(draft.form!.thinking, "because the image flips");
	assert.deepEqual([...draft.form!.selection.selected], [2]);
	assert.equal(draft.form!.confidenceIndex, 3);
	assert.equal(draft.readingThinking, "notes while reading");
});
