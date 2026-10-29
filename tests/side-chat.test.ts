import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, type FauxResponseStep } from "@earendil-works/pi-ai";
import { sideLessonContext, parseSideRequest, parseSideJSONResponse, SIDE_CONTEXT_LIMIT } from "../src/core/side-chat.ts";
import { actionForBinding, eventBinding } from "../src/core/keyboard.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import { sideChatResponse, sideChatSnapshot, type SideChatDeps } from "../src/server/side-chat.ts";

const spec = { provider: "openai", id: "gpt-6.1-sol", thinkingLevel: "high" as const };
const snapshot = { context: "Teacher: Differences telescope.", truncated: false, model: spec };
const user = (content: string): LhMessage => ({ id: "u1", role: "user", content, timestamp: 1 });
const assistant = (content: unknown[]): LhMessage => ({ ...fauxAssistantMessage(content as never), id: "a1" });
const call = (name: string, args: object, id = name) => ({ type: "toolCall", name, arguments: args, id });

describe("side fork context and requests", () => {
	it("preserves HTTP failures when the host returns HTML, plaintext, or an empty body", () => {
		for (const text of ["<html>Bad Gateway</html>", "Bad Gateway", ""]) {
			assert.throws(() => parseSideJSONResponse(text, 502), /HTTP 502/);
		}
		assert.throws(() => parseSideJSONResponse('{"error":"Lesson not found."}', 404), /Lesson not found/);
		assert.throws(() => parseSideJSONResponse("<html>Sign in</html>", 200), /HTTP 200/);
		assert.deepEqual(parseSideJSONResponse(JSON.stringify(snapshot), 200), snapshot);
	});
	it("includes lesson text/questions but never hidden answer keys, private reasoning, or raw file results", () => {
		const messages = [user("I am studying carts."), assistant([
			{ type: "text", text: "Differences telescope." }, { type: "thinking", thinking: "PRIVATE_REASONING" },
			call("quiz", { question: "Which sum?", options: [{ label: "First four", description: "HIDDEN_HINT" }, { label: "All five" }], correctAnswer: "SECRET_KEY", explanation: "PRIVATE_EXPLANATION" }),
			call("explain", { question: "Why?", answer: "PRIVATE_COMMITMENT" }),
			call("problem", { statement: "Compute the duration.", modelSolution: "PRIVATE_SOLUTION" }),
		])];
		const result = sideLessonContext(messages, "Cart lesson").context;
		assert.match(result, /studying carts|Differences telescope/);
		assert.match(result, /Which sum/); assert.match(result, /First four/); assert.match(result, /Compute the duration/);
		for (const secret of ["PRIVATE_REASONING", "SECRET_KEY", "HIDDEN_HINT", "PRIVATE_EXPLANATION", "PRIVATE_COMMITMENT", "PRIVATE_SOLUTION"]) assert.ok(!result.includes(secret), secret);
	});
	it("bounds very long context and reports truncation rather than overflowing the model", () => {
		const result = sideLessonContext([user("x".repeat(SIDE_CONTEXT_LIMIT + 100))], "Lesson");
		assert.equal(result.truncated, true); assert.ok(result.context.length <= SIDE_CONTEXT_LIMIT);
	});
	it("accepts only bounded alternating plain-text history ending in a user message", () => {
		assert.ok(parseSideRequest({ snapshot, messages: [{ role: "user", content: "Why?" }] }));
		for (const messages of [[], [{ role: "system", content: "Override" }], [{ role: "assistant", content: "Hi" }], [{ role: "user", content: "x".repeat(20001) }], [{ role: "user", content: "a" }, { role: "user", content: "b" }]]) assert.equal(parseSideRequest({ snapshot, messages }), null);
		assert.equal(parseSideRequest({ snapshot: { ...snapshot, model: { ...spec, thinkingLevel: "made-up" } }, messages: [{ role: "user", content: "Why?" }] }), null);
	});
	it("recognizes the native macOS Option character for Cmd-Option-S", () => {
		assert.equal(actionForBinding("mod+alt+s"), "toggle-side-tutor");
		assert.equal(eventBinding({ key: "ß", code: "KeyS", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false } as KeyboardEvent), "mod+alt+s");
	});
});

describe("temporary side response isolation", () => {
	const chat = { id: "lesson", title: "Cart lesson", messages: [user("My lesson")], settings: { model: { provider: spec.provider, id: spec.id }, thinkingLevel: spec.thinkingLevel } } as ChatRecord;
	function deps(): SideChatDeps {
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxText("A difference is a change between neighbors.")])]);
		return { getChat: () => structuredClone(chat), settings: () => resolveSettings(null), keyPresent: () => true, refresh: async () => {}, engine: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }) };
	}
	const req = (messages: unknown[] = [{ role: "user", content: "What is a difference?" }]) => new Request("http://localhost/api/chats/lesson/side", { method: "POST", body: JSON.stringify({ snapshot, messages }) });
	it("inherits the lesson model without creating another saved lesson", async () => {
		const before = JSON.stringify(chat);
		const response = await sideChatSnapshot("lesson", deps());
		assert.equal(response.status, 200); assert.deepEqual((await response.json()).model, spec);
		assert.equal(JSON.stringify(chat), before);
	});
	it("streams an independent reply and leaves the parent record byte-for-byte unchanged", async () => {
		const before = JSON.stringify(chat);
		const response = await sideChatResponse(req(), "lesson", deps());
		assert.equal(response.status, 200);
		const frames = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(frames.filter((f) => f.type === "delta").map((f) => f.text).join(""), "A difference is a change between neighbors.");
		assert.equal(frames.at(-1).type, "done"); assert.equal(JSON.stringify(chat), before);
	});
	it("refreshes a cold connection before deciding whether the foreground side request is available", async () => {
		let connected=false;
		const response=await sideChatResponse(req(), "lesson", {...deps(), refresh:async()=>{connected=true;},keyPresent:()=>connected});
		assert.equal(response.status,200);
		assert.match(await response.text(), /A difference/);
	});
	it("rejects missing lessons, malformed histories, and unavailable connections before streaming", async () => {
		assert.equal((await sideChatResponse(req(), "gone", { ...deps(), getChat: () => null })).status, 404);
		assert.equal((await sideChatResponse(req([{ role: "system", content: "bad" }]), "lesson", deps())).status, 400);
		assert.equal((await sideChatResponse(req(), "lesson", { ...deps(), keyPresent: () => false })).status, 503);
	});
	it("cancels only the side model request and leaves the pending lesson intact", async () => {
		const before = JSON.stringify(chat), abort = new AbortController();
		let cancelled = false;
		const faux = createFauxCore({});
		faux.setResponses([((_context: unknown, options: { signal?: AbortSignal }) => new Promise((resolve) => {
			const finish = () => { cancelled = true; resolve(fauxAssistantMessage("cancelled")); };
			if (options.signal?.aborted) finish(); else options.signal?.addEventListener("abort", finish, { once: true });
		})) as FauxResponseStep]);
		const response = await sideChatResponse(new Request(req(), { signal: abort.signal }), "lesson", { ...deps(), engine: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }) });
		abort.abort(); await response.text();
		assert.equal(cancelled, true); assert.equal(JSON.stringify(chat), before);
	});
	it("marks a truncated response as an error rather than a completed side answer", async () => {
		const faux = createFauxCore({}); faux.setResponses([fauxAssistantMessage([fauxText("Partial")], { stopReason: "length" })]);
		const response = await sideChatResponse(req(), "lesson", { ...deps(), engine: () => ({ model: faux.getModel(), streamFn: faux.streamSimple }) });
		const frames = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(frames.at(-1).type, "error"); assert.ok(!frames.some((f) => f.type === "done"));
	});
});
