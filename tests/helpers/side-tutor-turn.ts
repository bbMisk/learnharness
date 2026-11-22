/**
 * One real request cycle through chat-handler with a faux model: what the
 * model receives (system prompt, messages, tools — normalized for per-run
 * noise) and how many times the chat store's record read ran during the
 * turn. Imports only what existed at 4f297a67, so the same file run in an
 * export of that commit produced tests/fixtures/side-tutor-turn-baseline.json:
 *
 *   node --import tsx tests/helpers/side-tutor-turn.ts > baseline.json
 *
 * The caller sets LH_DATA_DIR and NODE_ENV=test before importing this.
 */
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../../src/store/chats.ts");
const { handleChatRequest } = await import("../../src/server/chat-handler.ts");
const { runningTurn } = await import("../../src/server/turn-runs.ts");
const { createTeacherAgent } = await import("../../src/agent/teacher-agent.ts");
const { newUserMessage } = await import("../../src/core/native-messages.ts");

const again = { name: "again", label: "again", description: "Continue", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }) };

/** The fixed lesson the baseline was taken on: one earlier exchange. */
export function lessonMessages() {
	return [
		{ ...newUserMessage("What is a limit?"), id: "u0", timestamp: 1 },
		{ ...fauxAssistantMessage([fauxText("A limit is the value a function approaches.")]), id: "a0", timestamp: 2 },
	];
}

export function seedLesson(messages: unknown[] = lessonMessages()): string {
	const chat = chatStore.createChat("side tutor turn");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveMessages(chat.id, messages as never);
	return chat.id;
}

/** Per-run noise only: timestamps, durations, response ids, and each faux
 *  core instance's own api id. */
export function normalize(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value, (key, v) =>
		key === "timestamp" || key === "durationMs" || key === "responseId" ? 0 : key === "api" && typeof v === "string" && v.startsWith("faux:") ? "faux" : v));
}

/** Run "Teach me derivatives" on `chatId`: a tool step, then the reply. */
export async function captureTurn(chatId: string) {
	const contexts: unknown[] = [];
	const faux = createFauxCore({});
	faux.setResponses([
		(context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage([fauxToolCall("again", {}, { id: "again-1" })], { stopReason: "toolUse" }); },
		(context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage([fauxText("Done.")]); },
	]);
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple };
	let built: Record<string, unknown> | undefined;
	const read = chatStore.getChat;
	let storeReads = 0;
	chatStore.getChat = ((id: string) => { storeReads++; return read(id); }) as typeof read;
	try {
		const ack = await handleChatRequest(new Request("http://test/api/chat", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId, input: { type: "text", text: "Teach me derivatives" } }),
		}), (opts) => {
			built = opts as unknown as Record<string, unknown>;
			return createTeacherAgent(undefined, { ...opts, engine, tools: { again } });
		});
		if (ack.status !== 200) throw new Error(`turn ${ack.status}: ${await ack.text()}`);
		const handle = runningTurn(chatId);
		if (handle) await new Response(handle.subscribe()).text();
	} finally {
		chatStore.getChat = read;
	}
	return {
		requests: normalize(contexts),
		storeReads,
		hooks: { contextUpdates: typeof built?.contextUpdates === "function", validateContext: typeof built?.validateContext === "function" },
	};
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
	const result = await captureTurn(seedLesson());
	console.log(JSON.stringify({ requests: result.requests, storeReads: result.storeReads, ...(process.env.LH_FORK_SIDE_CHAT ? { hooks: result.hooks } : {}) }));
}
