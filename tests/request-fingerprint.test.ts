/** Cache-miss diagnostics (2026-11-01): each conversation step records a
 * fingerprint of the request really sent — promptHash over instructions +
 * tools, extendsPrevious when the history only appended — taken at the
 * ChatGPT adapter's final prepared body. Fake IPC + fake fetch: no network,
 * no real model. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxText, type Model, type Usage } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-request-fingerprint-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { piModels, piEngineForSpec } = await import("../src/agent/models.ts");
const { refreshChatGPTModels } = await import("../src/agent/chatgpt-bridge.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { fingerprintResponsesPayload, resetRequestFingerprints } = await import("../src/agent/request-fingerprint.ts");
const { turnStepUsage } = await import("../src/server/chat-handler.ts");
const { chatStore } = await import("../src/store/chats.ts");
import type { RequestFingerprint, TurnUsage } from "../src/core/contracts.ts";

const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const realFetch = globalThis.fetch;
const desktopMarker = process.env.LH_DESKTOP_SERVER, desktopSecret = process.env.LH_DESKTOP_API_SECRET;
const model = piModels().getModel("openai", "gpt-5") as Model<"openai-responses">;
const status = { available: true, pending: false, allowBackgroundUse: false, activeId: "scratch", accounts: [{ id: "scratch", registration: "oaiapp_scratch", email: "dummy@example.invalid", connected: true, planEnabled: true, background: false }], error: null };
const ipc = (m: unknown) => (process.emit as (name: string, m: unknown) => boolean)("message", m);
/** Bodies the fake transport received, in order. */
let bodies: Array<{ input: unknown[] }> = [];
/** Next fetch answers with a tool call to `again` instead of text. */
let toolNext = false;
const sse = (events: unknown[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const usage = { input_tokens: 40, output_tokens: 2, total_tokens: 42, input_tokens_details: { cached_tokens: 30 } };

before(async () => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (m: any, callback?: () => void) => {
		const value = { epoch: 1, authorityRevision: 1, revision: 1, ...(m.op === "lease" ? { accountId: "scratch", accessToken: "dummy-oauth" } : { status, accountId: "scratch", models: [{ id: model.id, name: "Scratch" }] }) };
		queueMicrotask(() => ipc({ channel: "lh:chatgpt", id: m.id, op: m.op, ok: true, value })); callback?.(); return true;
	} });
	await refreshChatGPTModels([model]);
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.url, "https://api.openai.com/v1/responses");
		bodies.push(JSON.parse(await request.text()));
		if (toolNext) {
			toolNext = false;
			const call = { type: "function_call", id: "fc_again", call_id: "call_again", name: "again", namespace: "learnharness", arguments: "{}", status: "completed" };
			return sse([{ type: "response.output_item.added", output_index: 0, item: call }, { type: "response.output_item.done", output_index: 0, item: call }, { type: "response.completed", response: { status: "completed", output: [call], usage } }]);
		}
		const item = { id: "msg_scratch", type: "message", role: "assistant", content: [{ type: "output_text", text: "Scratch reply", annotations: [] }] };
		return sse([{ type: "response.created", response: { id: "resp_scratch" } }, { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }, { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Scratch reply" }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { status: "completed", output: [item], usage } }]);
	};
});
after(() => {
	if (desktopMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = desktopMarker;
	if (desktopSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = desktopSecret;
	globalThis.fetch = realFetch;
	fs.rmSync(scratch, { recursive: true, force: true });
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
});

const tool = (name: string, description = "scratch"): AgentTool<any> => ({ name, label: name, description, parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "Done" }], details: {} }) });
type Step = { usage: Usage; request?: RequestFingerprint };
function chatGPTAgent(chatId: string | undefined, steps: Step[], opts: { messages?: AgentMessage[]; projectContext?: string; tools?: Record<string, AgentTool<any>> } = {}) {
	return createTeacherAgent(undefined, {
		engine: piEngineForSpec({ provider: "chatgpt", id: model.id }, false),
		chatId,
		messages: opts.messages ?? [],
		projectContext: opts.projectContext,
		tools: opts.tools ?? { again: tool("again") },
		onUsage: (usage, request) => steps.push({ usage, request }),
	});
}
const isPrefix = (prefix: unknown[], whole: unknown[]) => prefix.length <= whole.length && prefix.every((item, i) => JSON.stringify(item) === JSON.stringify(whole[i]));

test("(1) consecutive calls that only append: same promptHash, extendsPrevious true (first call has none)", async () => {
	resetRequestFingerprints(); bodies = [];
	const steps: Step[] = [];
	const agent = chatGPTAgent("chat-append", steps);
	toolNext = true; // a tool loop: two requests in one run
	await agent.prompt("First learner message");
	await agent.prompt("Second learner message");
	assert.equal(steps.length, 3);
	assert.equal(bodies.length, 3);
	// The claim matches the wire: each body's history starts with the previous one.
	assert(isPrefix(bodies[0]!.input, bodies[1]!.input) && isPrefix(bodies[1]!.input, bodies[2]!.input));
	const [first, second, third] = steps.map((s) => s.request!);
	assert.match(first!.promptHash, /^[0-9a-f]{12}$/);
	assert.equal("extendsPrevious" in first!, false, "the chat's first call in this process has no previous");
	assert.deepEqual(second, { promptHash: first!.promptHash, extendsPrevious: true });
	assert.deepEqual(third, { promptHash: first!.promptHash, extendsPrevious: true });
	// Usage is untouched by the fingerprint.
	assert.equal(steps[0]!.usage.cacheRead, 30);
	// The persisted step carries both fields.
	assert.deepEqual(turnStepUsage(steps[1]!.usage, second), { ...turnStepUsage(steps[1]!.usage), promptHash: first!.promptHash, extendsPrevious: true });
});

test("(2) changed instructions or tools: new promptHash, extendsPrevious false; rewritten history: same hash, false", async () => {
	resetRequestFingerprints(); bodies = [];
	const steps: Step[] = [];
	const base = chatGPTAgent("chat-change", steps);
	await base.prompt("Learner message");
	const original = steps[0]!.request!.promptHash;
	// Like the record: the agent's seeded system message never persists.
	const history = base.state.messages.filter((m) => m.role !== "system");

	// Changed instructions (project context joins the system prompt).
	await chatGPTAgent("chat-change", steps, { messages: history, projectContext: "Changed project context" }).prompt("Next");
	const instructions = steps[1]!.request!;
	assert.notEqual(instructions.promptHash, original);
	assert.equal(instructions.extendsPrevious, false);

	// Changed tool definitions (same instructions as the previous call).
	await chatGPTAgent("chat-change", steps, { messages: history, projectContext: "Changed project context", tools: { again: tool("again", "a different description") } }).prompt("Next");
	const tools = steps[2]!.request!;
	assert.notEqual(tools.promptHash, instructions.promptHash);
	assert.notEqual(tools.promptHash, original);
	assert.equal(tools.extendsPrevious, false);

	// Same prompt and tools, but the earlier history no longer matches.
	await chatGPTAgent("chat-change", steps, { messages: [], projectContext: "Changed project context", tools: { again: tool("again", "a different description") } }).prompt("Fresh start");
	assert.deepEqual(steps[3]!.request, { promptHash: tools.promptHash, extendsPrevious: false });
});

test("fingerprint state is per chat, model-sensitive, prefix-exact and bounded", () => {
	resetRequestFingerprints();
	const dev = { role: "developer", content: "Rules" };
	const body = (input: unknown[], over: Record<string, unknown> = {}) => ({ model: "gpt-5", tools: [{ name: "t" }], input: [dev, ...input], ...over });
	const a = fingerprintResponsesPayload("A", body([{ role: "user", content: "1" }]))!;
	assert.equal(a.extendsPrevious, undefined);
	// Another chat does not see A's previous request.
	assert.equal(fingerprintResponsesPayload("B", body([{ role: "user", content: "1" }]))!.extendsPrevious, undefined);
	// Identical history (a retry) still starts with the previous one.
	assert.equal(fingerprintResponsesPayload("A", body([{ role: "user", content: "1" }]))!.extendsPrevious, true);
	// An edited earlier item breaks the prefix even though the length grew.
	assert.equal(fingerprintResponsesPayload("A", body([{ role: "user", content: "1 edited" }, { role: "user", content: "2" }]))!.extendsPrevious, false);
	// A shorter history cannot extend.
	assert.equal(fingerprintResponsesPayload("A", body([]))!.extendsPrevious, false);
	// A model switch is never an extension (the cache is per model).
	assert.equal(fingerprintResponsesPayload("A", body([], { model: "gpt-5-mini" }))!.extendsPrevious, false);
	// The system prompt is part of promptHash, not of the history.
	assert.notEqual(fingerprintResponsesPayload("C", { ...body([]), input: [{ role: "developer", content: "Other rules" }] })!.promptHash, a.promptHash);
	// Not a Responses body: nothing to fingerprint.
	assert.equal(fingerprintResponsesPayload("D", { messages: [] }), undefined);
	// Bounded: one entry per chat, the oldest chats evicted past the cap.
	for (let i = 0; i < 300; i++) fingerprintResponsesPayload(`bulk-${i}`, body([]));
	assert.equal(fingerprintResponsesPayload("A", body([]))!.extendsPrevious, undefined, "A was evicted");
	assert.equal(fingerprintResponsesPayload("bulk-299", body([]))!.extendsPrevious, true);
});

test("(3) engines/paths that cannot observe their body record usage without the fields", async () => {
	resetRequestFingerprints();
	// A faux engine (stands in for API-key / Claude Code / other subscriptions).
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([fauxText("One")]), fauxAssistantMessage([fauxText("Two")])]);
	const fauxSteps: Step[] = [];
	const agent = createTeacherAgent(undefined, { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, chatId: "chat-faux", tools: {}, onUsage: (usage, request) => fauxSteps.push({ usage, request }) });
	await agent.prompt("Hello");
	await agent.prompt("Again");
	assert.equal(fauxSteps.length, 2);
	for (const step of fauxSteps) {
		assert.equal(step.request, undefined);
		const persisted = turnStepUsage(step.usage, step.request);
		assert.equal("promptHash" in persisted, false);
		assert.equal("extendsPrevious" in persisted, false);
		assert.equal(typeof persisted.inputTokens, "number");
	}
	// ChatGPT without a chat id (no conversation to compare against): no fields,
	// and the call does not touch any chat's previous request.
	const steps: Step[] = [];
	await chatGPTAgent(undefined, steps).prompt("Untracked");
	assert.equal(steps.length, 1);
	assert.equal(steps[0]!.request, undefined);
});

test("old records without the fields and new ones with them load side by side", () => {
	const record = chatStore.createChat("fingerprint fixture");
	const base = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 };
	const old: TurnUsage = { id: "old", messageId: "m1", at: "x", model: "chatgpt:gpt-5", steps: [base] };
	const fresh: TurnUsage = { id: "new", messageId: "m2", at: "y", model: "chatgpt:gpt-5", steps: [{ ...base, promptHash: "0123456789ab" }, { ...base, promptHash: "0123456789ab", extendsPrevious: true }] };
	chatStore.appendTurnUsage(record.id, old);
	chatStore.appendTurnUsage(record.id, fresh);
	const turns = chatStore.getChat(record.id)!.turns!;
	assert.deepEqual(turns, [old, fresh]);
});
