import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mistake-cards-"));
process.env.LH_DATA_DIR = temp;
process.env.LH_AUTH_FILE = path.join(temp, "auth.json");
const { stores } = await import("../src/server/stores.ts");
const { piModels } = await import("../src/agent/models.ts");
const { lessonTrackingTools } = await import("../src/agent/tools/lesson-tracking.ts");
const { writeMistakeCard, MISTAKE_CARD_PROMPT } = await import("../src/server/mistake-cards.ts");
const { reviewCatalog } = await import("../src/server/review.ts");
const { readMistakeCards } = await import("../src/store/mistake-cards.ts");
const { readFlashcardCuration } = await import("../src/store/flashcard-curation.ts");
const { saveReviewQuestion } = await import("../src/store/review-questions.ts");
const { projectStore } = await import("../src/store/projects.ts");
const { setChatOrganization } = await import("../src/store/chats.ts");

const faux = fauxProvider({ provider: "faux-mistakes", models: [{ id: "cheap-1" }] });
piModels().setProvider(faux.provider);
const contexts: TranscriptContext[] = [];
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const front = "What is $\\bigcap_{n\\ge 1}(-1/n, 1+1/n)$?";
const back = "$[0, 1]$: 0 and 1 lie in every interval, and any point outside $[0,1]$ is outside some interval.";

/** The tutor's mistake tools, writing each logged mistake's card as the chat handler does. */
function lesson(chatId: string) {
	const writes: Promise<void>[] = [];
	const tools = lessonTrackingTools(
		{ chatId, chatStore: stores.chatStore, onMistake: (mistake) => void writes.push(writeMistakeCard(chatId, mistake)) },
		{ problems: false },
	);
	const run = async (name: string, input: unknown) => {
		const result = await tools[name]!.execute(`call_${name}`, input as never);
		return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
	};
	return { writes, run };
}

it("note_mistake writes a card into the lesson's deck that survives resolve_mistake", async () => {
	stores.settingsStore.writeSettings({
		version: 1,
		models: { cheap: { model: { provider: "faux-mistakes", id: "cheap-1" } } },
		agent: { flashcards: { enabled: true } },
	});
	faux.setResponses([
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxToolCall("submit_card", { front, back }, { id: "card-1" })]);
		},
	]);
	const chat = stores.chatStore.createChat("Real analysis");
	const project = projectStore.create("Analysis");
	setChatOrganization(chat.id, { projectId: project.id });
	const { writes, run } = lesson(chat.id);

	assert.deepEqual(await run("note_mistake", { text: "Copies the open endpoints of the sets as the intersection" }), { ok: true, id: "m1" });
	await Promise.all(writes);
	const sent = JSON.stringify(contexts[0]);
	assert.ok(sent.includes(JSON.stringify(MISTAKE_CARD_PROMPT).slice(1, -1)), "the writer's instruction is sent");
	assert.match(sent, /Copies the open endpoints/);

	const stored = readMistakeCards()[`mistake_${chat.id}_m1`]!;
	assert.equal(stored.front, front);
	assert.equal(stored.back, back);
	assert.deepEqual(readFlashcardCuration().decisions[stored.revision], { keep: true, priority: 100, reason: "Lesson mistake" });

	const inCatalog = () => reviewCatalog(Date.now()).find((card) => card.id === stored.id);
	const card = inCatalog()!;
	assert.equal(card.front, front);
	assert.equal(card.deckId, chat.id);
	assert.equal(card.deckName, "Real analysis");
	assert.deepEqual(card.projectIds, [project.id]);
	assert.equal(card.mcq, undefined);

	// The curator's question attaches by revision, like any card's.
	const mcq = { prompt: front, options: ["$[0,1]$", "$(0,1)$", "$(-1,2)$", "$\\emptyset$"], correctIndex: 0, explanation: back };
	saveReviewQuestion(stored.revision, mcq);
	assert.deepEqual(inCatalog()!.mcq, mcq);

	assert.deepEqual(await run("resolve_mistake", { id: "m1" }), { ok: true });
	assert.ok(inCatalog(), "the card stays after the mistake is resolved");
});

it("a failed card write leaves note_mistake working and makes no card", async () => {
	stores.settingsStore.writeSettings({ version: 1 }); // no Cheap model: the writer refuses
	const chat = stores.chatStore.createChat("No model");
	const { writes, run } = lesson(chat.id);
	assert.deepEqual(await run("note_mistake", { text: "Treats the variance as the standard deviation" }), { ok: true, id: "m1" });
	await Promise.all(writes);
	assert.equal(readMistakeCards()[`mistake_${chat.id}_m1`], undefined);
	assert.deepEqual(await run("note_mistake", { text: "Drops the n in the Fisher information" }), { ok: true, id: "m2" });
	await Promise.all(writes);
});

it("the writer sees the learner's answer, and nothing runs with automatic flashcards off (review findings)", async () => {
	const chat = stores.chatStore.createChat("Answers");
	stores.chatStore.saveMessages(chat.id, [
		{ id: "u1", role: "user", content: "teach me intersections", timestamp: 1 } as never,
		{ id: "a1", role: "assistant", content: [{ type: "toolCall", id: "q1", name: "quiz", arguments: { question: "What is $\\bigcap_n (-1/n, 1+1/n)$?" } }], timestamp: 2 } as never,
		{ id: "r1", role: "toolResult", toolCallId: "q1", toolName: "quiz", content: [{ type: "text", text: "{\"answers\":[\"(0,1)\"]}" }], isError: false, timestamp: 3 } as never,
	]);
	stores.settingsStore.writeSettings({ version: 1, models: { cheap: { model: { provider: "faux-mistakes", id: "cheap-1" } } }, agent: { flashcards: { enabled: false } } });
	const calls: unknown[] = [];
	faux.setResponses([(context) => { calls.push(context); return fauxAssistantMessage([fauxToolCall("submit_card", { front, back }, { id: "card-off" })]); }]);
	await writeMistakeCard(chat.id, { id: "m1", text: "Copies the open endpoints" });
	assert.equal(calls.length, 0, "automatic flashcards off: no model call");
	assert.equal(readMistakeCards()[`mistake_${chat.id}_m1`], undefined);

	stores.settingsStore.writeSettings({ version: 1, models: { cheap: { model: { provider: "faux-mistakes", id: "cheap-1" } } }, agent: { flashcards: { enabled: true } } });
	await writeMistakeCard(chat.id, { id: "m1", text: "Copies the open endpoints" });
	const sent = JSON.stringify(calls[0]);
	assert.match(sent, /Tutor asked: What is/);
	assert.match(sent, /Learner answered:/);
	assert.match(sent, /Learner: teach me intersections/);
});

