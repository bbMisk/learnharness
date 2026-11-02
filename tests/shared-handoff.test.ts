/**
 * SHARED HANDOFF PREFIX (opt-in, Settings → General; src/agent/shared-handoff.ts)
 * end to end through the chat handler on the ChatGPT engine: a real prober run
 * (probe_done + closing sentence), the real handoff wake, a real teacher run
 * (a question) and the teacher's rebuild after the learner's answer. Every
 * request body is captured at fetch; nothing leaves the process (fake IPC
 * bridge, fake fetch, temp data dir).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";

assert.equal(process.env.NODE_ENV, "test", "Run with NODE_ENV=test; these tests must not invoke real providers.");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-shared-handoff-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: "d".repeat(64), ANTHROPIC_API_KEY: "fixture" };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };
const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");

const { piModels, piEngineForSpec } = await import("../src/agent/models.ts");
const { composeInstructions, createProberAgent, createTeacherAgent, bareQuestionTools } = await import("../src/agent/teacher-agent.ts");
const { HANDOFF_UPDATE_TEXT, handoffIndex, sharedHandoffMessages, sharedHandoffSupported } = await import("../src/agent/shared-handoff.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { createProberTools } = await import("../src/agent/tools.ts");
const { danglingQuestionOf, toLlmMessages } = await import("../src/core/native-messages.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");
const { parseGeneralSettingsBody } = await import("../src/server/settings-body.ts");

const MODEL_ID = "gpt-6.1-sol";
const model = piModels().getModel("openai", MODEL_ID) as Model<"openai-responses">;
const status = { available: true, pending: false, allowBackgroundUse: true, activeId: "scratch-account", accounts: [{ id: "scratch-account", email: "dummy@example.invalid", registration: "oaiapp_scratch", connected: true, planEnabled: true, background: true }], error: null };
const ipc = (value: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", value);

type Body = Record<string, any> & { input: any[] };
let requests: Body[] = [];
let script: unknown[][] = [];

before(() => {
	assert(model, `pi's catalog lists ${MODEL_ID}`);
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (message: any, callback?: () => void) => {
		queueMicrotask(() => ipc({ channel: "lh:chatgpt", id: message.id, op: message.op, ok: true,
			value: message.op === "lease"
				? { accessToken: "scratch-oauth-only", accountId: "scratch-account", epoch: 1, authorityRevision: 1, revision: 1 }
				: { epoch: 1, authorityRevision: 1, revision: 1, status, accountId: "scratch-account", models: [{ id: MODEL_ID, name: "Scratch account model" }] } }));
		callback?.(); return true;
	} });
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.url, "https://api.openai.com/v1/responses");
		requests.push(JSON.parse(await request.text()));
		const events = script.shift();
		assert(events, `unscripted request #${requests.length}`);
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	};
});
after(() => {
	process.env = originalEnv; globalThis.fetch = originalFetch;
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete process.send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	fs.rmSync(directory, { recursive: true, force: true });
});

const usage = { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const reply = (item: Record<string, unknown>) => [
	{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", ...(item.type === "message" ? { content: [] } : {}) } },
	{ type: "response.output_item.done", output_index: 0, item },
	{ type: "response.completed", response: { id: `resp_${String(item.id)}`, status: "completed", output: [item], usage } },
];
const call = (id: string, name: string, args: unknown) => reply({ type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args), status: "completed" });
const text = (id: string, value: string) => reply({ type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: value, annotations: [] }] });

async function settle(chatId: string, until: () => boolean) {
	for (let waited = 0; waited < 15_000; waited += 25) {
		const handle = runningTurn(chatId);
		if (handle) await new Response(handle.subscribe()).text();
		else if (until()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail("the lesson did not settle");
}

/** One lesson: probe → handoff wake → teacher question → answer → teacher reaction. */
async function lesson(general: Record<string, unknown>): Promise<{ chatId: string; bodies: Body[] }> {
	writeSettings({ version: 1, graph: { enabled: false }, general, models: { strong: { model: { provider: "chatgpt", id: MODEL_ID } } } });
	requests = [];
	script = [
		call("probe", "probe_done", { assessment: { strands: [{ strand: "limits", assessment: "Gets the intuition; the epsilon-delta form is new." }] } }),
		text("closing", "Thanks, that tells me where to start."),
		call("ask", "ask_user_question", { question: "Which kind of function should the first example use?" }),
		text("reaction", "Good, polynomials it is."),
	];
	const chat = chatStore.createChat("Shared handoff fixture");
	const first = await handleChatInput(chat.id, { type: "text", text: "Teach me limits." });
	assert.equal(first.status, 200, await first.clone().text());
	await settle(chat.id, () => requests.length === 3 && !!danglingQuestionOf(chatStore.getChat(chat.id)!.messages));
	const question = danglingQuestionOf(chatStore.getChat(chat.id)!.messages)!;
	const answered = await handleChatInput(chat.id, { type: "answer", toolCallId: question.toolCallId, answer: {
		kind: "ask", tool: "ask_user_question", questionText: "Which kind of function should the first example use?",
		dontKnow: false, answers: [], text: "Polynomials", answeredAt: new Date(0).toISOString(),
	} });
	assert.equal(answered.status, 200, await answered.clone().text());
	await settle(chat.id, () => requests.length === 4);
	assert.equal(script.length, 0, "every scripted reply was requested");
	return { chatId: chat.id, bodies: requests };
}

const withoutInput = ({ input: _input, ...rest }: Body) => rest;
const toolNames = (item: any): string[] => item.tools.map((tool: { name: string }) => tool.name);
const proberInstructions = composeInstructions("prober");
const teacherInstructions = composeInstructions("teacher");

test("the setting is opt-in: default OFF, sanitized, validated, resolved", () => {
	assert.equal(resolveSettings(null).general.sharedHandoffPrefix, false);
	assert.equal(resolveSettings({ version: 1, general: { sharedHandoffPrefix: true } }).general.sharedHandoffPrefix, true);
	assert.deepEqual(sanitizeUserSettings({ version: 1, general: { sharedHandoffPrefix: "yes" } })?.general, {});
	assert.deepEqual(parseGeneralSettingsBody({ sharedHandoffPrefix: true }), { ok: true, settings: { sharedHandoffPrefix: true } });
	assert.equal(parseGeneralSettingsBody({ sharedHandoffPrefix: 1 }).ok, false);
});

test("eligibility: mid-conversation system messages AND tool changes, else today's request", () => {
	assert.equal(sharedHandoffSupported(model), true, `${MODEL_ID}: Responses "changes" tool mode`);
	assert.equal(sharedHandoffSupported({ ...model, provider: "chatgpt" }), true);
	assert.equal(sharedHandoffSupported(piModels().getModel("openai", "gpt-4.1")!), false, "no mid-conversation system messages");
	assert.equal(sharedHandoffSupported({ ...model, compat: { ...model.compat, supportsAdditionalTools: false } }), false, "system messages without tool changes");
	const claude = piModels().getModel("anthropic", "claude-opus-5-5");
	assert.equal(sharedHandoffSupported(claude!), true, "native tool_addition / tool_removal blocks");
	assert.equal(sharedHandoffSupported({ ...claude!, compat: { ...claude!.compat, supportsMidConvoToolChanges: false } }), false);
	assert.equal(sharedHandoffSupported({ ...claude!, provider: "claude-code" }), false);
});

test("ON: the teacher keeps the prober's request prefix and gets its own instructions and tools at the handoff", async () => {
	const { bodies } = await lesson({ sharedHandoffPrefix: true });
	const [probe, closing, teacherFirst, teacherSecond] = bodies as [Body, Body, Body, Body];

	// The prober's own requests are today's: its tools, then its instructions.
	assert.equal(probe.input[0].type, "additional_tools");
	assert(toolNames(probe.input[0]).includes("probe_done"));
	assert.deepEqual(probe.input[1], { role: "developer", content: proberInstructions });
	assert.deepEqual(closing.input.slice(0, probe.input.length), probe.input);

	// Everything but input is the same request: model, cache key, reasoning, …
	assert.equal(closing.prompt_cache_key, teacherFirst.prompt_cache_key);
	assert.deepEqual(withoutInput(teacherFirst), withoutInput(closing));
	assert.deepEqual(withoutInput(teacherSecond), withoutInput(teacherFirst));
	assert.equal(teacherFirst.tools, undefined, "tools ride the input, so the prefix is the input");

	// THE PROPERTY: the teacher's first request starts with the prober's last
	// request, item for item; the teacher's next run extends its first.
	assert.deepEqual(teacherFirst.input.slice(0, closing.input.length), closing.input);
	assert.deepEqual(teacherSecond.input.slice(0, teacherFirst.input.length), teacherFirst.input);
	assert.equal(JSON.stringify(teacherFirst.input).startsWith(JSON.stringify(closing.input).slice(0, -1)), true, "byte prefix of the serialized input");

	// After the prefix: the tool update, then the teacher's FULL instructions.
	const handoff = teacherFirst.input.slice(closing.input.length);
	const added = handoff.find((item: any) => item.type === "additional_tools");
	assert(added, "the teacher's tools are declared at the handoff");
	for (const name of ["quiz", "plan_init"]) assert(toolNames(added).includes(name), `teacher tool ${name}`);
	const update = handoff.find((item: any) => item.role === "developer" && String(item.content).startsWith(HANDOFF_UPDATE_TEXT));
	assert(update, "the teacher's instructions arrive as a mid-conversation update");
	assert(update.content.includes(`${HANDOFF_UPDATE_TEXT}\n\n${teacherInstructions}`), "the teacher's full instructions, verbatim");
	assert.match(update.content, /no longer available[\s\S]*- probe_done/, "the prober-only tools are withdrawn");
	assert(handoff.indexOf(added) < handoff.indexOf(update));
	// The update sits at the handoff point: after probe_done's result, before the closing sentence.
	const outputs = teacherFirst.input.flatMap((item: any, index: number) => item.type === "function_call_output" ? [index] : []);
	assert.equal(teacherFirst.input[closing.input.length - 1].type, "function_call_output");
	assert.equal(outputs.at(-1), closing.input.length - 1);
	const after = handoff.slice(handoff.indexOf(update) + 1);
	assert.equal(after[0].role, "assistant", "the prober's closing sentence follows the update");
	assert.equal(after[1].role, "user", "then the handoff wake");

	// Exactly one update, carried unchanged into every later teacher run.
	const updates = (body: Body) => body.input.filter((item: any) => item.role === "developer" && String(item.content).startsWith(HANDOFF_UPDATE_TEXT));
	assert.equal(updates(teacherFirst).length, 1);
	assert.equal(updates(teacherSecond).length, 1);
	assert.deepEqual(teacherSecond.input[1], { role: "developer", content: proberInstructions }, "still the prober's instructions up top");
	assert.equal(teacherSecond.input.filter((item: any) => item.type === "additional_tools").length, 2, "no further tool declarations");
});

test("OFF (and unset): today's teacher request — teacher instructions and tools lead; nothing of the update", async () => {
	const off = await lesson({ sharedHandoffPrefix: false });
	const unset = await lesson({});
	const normalize = (run: { chatId: string; bodies: Body[] }) => JSON.parse(JSON.stringify(run.bodies).replaceAll(run.chatId, "CHAT"));
	assert.deepEqual(normalize(off), normalize(unset), "explicit OFF is byte-identical to the default");
	const [, closing, teacherFirst, teacherSecond] = off.bodies as [Body, Body, Body, Body];
	assert.equal(teacherFirst.input[0].type, "additional_tools");
	assert(toolNames(teacherFirst.input[0]).includes("quiz"));
	assert(!toolNames(teacherFirst.input[0]).includes("probe_done"));
	assert.deepEqual(teacherFirst.input[1], { role: "developer", content: teacherInstructions });
	assert(!JSON.stringify(teacherFirst).includes(HANDOFF_UPDATE_TEXT));
	assert(!JSON.stringify(teacherFirst).includes(proberInstructions));
	assert.notDeepEqual(teacherFirst.input[0], closing.input[0], "today: the teacher's prefix differs from the first item");
	assert.deepEqual(teacherSecond.input.slice(0, teacherFirst.input.length), teacherFirst.input);
});

test("the handoff point depends only on the record, and a compaction past it falls back", () => {
	const base = { api: "openai-responses", provider: "chatgpt", model: MODEL_ID, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" };
	const record: any[] = [
		{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
		{ id: "a1", role: "assistant", ...base, content: [{ type: "toolCall", id: "c_done", name: "probe_done", arguments: {} }, { type: "toolCall", id: "c_read", name: "read", arguments: {} }], timestamp: 2 },
		{ id: "r1", role: "toolResult", toolCallId: "c_done", toolName: "probe_done", content: [{ type: "text", text: "ok" }], isError: false, details: { ok: true }, timestamp: 3 },
		{ id: "r2", role: "toolResult", toolCallId: "c_read", toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: 4 },
		{ id: "a2", role: "assistant", ...base, stopReason: "stop", content: [{ type: "text", text: "bye" }], timestamp: 5 },
	];
	assert.equal(handoffIndex(record), 4, "after probe_done's result AND its sibling's");
	assert.equal(handoffIndex([...record, { id: "u2", role: "user", content: [{ type: "text", text: "more" }], timestamp: 6 }]), 4, "stable as the lesson grows");
	assert.equal(handoffIndex(record.slice(0, 2)), null, "no concluded probe");
	const loadout = (prompt: string, names: string[]) => ({ systemPrompt: prompt, tools: names.map((name) => ({ name, label: name, description: name, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) })) as never });
	const shared = sharedHandoffMessages(record, loadout("P", ["probe_done", "read"]), loadout("T", ["quiz", "read"]))!;
	assert.deepEqual(shared.map((m: any) => m.id ?? m.role), ["system", "u1", "a1", "r1", "r2", "system", "a2"]);
	assert.deepEqual((shared[0] as any).toolsAdded.map((t: any) => t.name), ["probe_done", "read"]);
	assert.deepEqual((shared[5] as any).toolsAdded.map((t: any) => t.name), ["quiz"]);
	assert.deepEqual((shared[5] as any).toolsRemoved, [{ name: "probe_done" }]);
	assert.equal((shared[5] as any).content, `${HANDOFF_UPDATE_TEXT}\n\nT`);
	const compaction = (firstKeptMessageId: string) => [...record, { id: "k", role: "custom", customType: "compaction", content: "summary", display: false, details: { firstKeptMessageId, tokensBefore: 1 }, timestamp: 6 }];
	assert.equal(sharedHandoffMessages(compaction("a2"), loadout("P", ["probe_done"]), loadout("T", ["quiz"])), null, "compaction cut at/past the handoff: today's request");
	const early = sharedHandoffMessages(compaction("a1"), loadout("P", ["probe_done"]), loadout("T", ["quiz"]))!;
	const wire = toLlmMessages(early);
	assert.equal(wire.filter((m) => m.role === "system").length, 2, "a compaction during the probe keeps both system messages on the wire");
});

test("Anthropic: the same record gives the prober's system and tools, plus a native mid-conversation update", async () => {
	const record = chatStore.getChat(chatStore.createChat("Anthropic payload fixture").id)!;
	const base = { api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	const messages: any[] = [
		{ id: "u1", role: "user", content: [{ type: "text", text: "Teach me limits." }], timestamp: 1 },
		{ id: "a1", role: "assistant", ...base, stopReason: "toolUse", content: [{ type: "toolCall", id: "toolu_done", name: "probe_done", arguments: { assessment: { strands: [{ strand: "limits", assessment: "new" }] } } }], timestamp: 2 },
		{ id: "r1", role: "toolResult", toolCallId: "toolu_done", toolName: "probe_done", content: [{ type: "text", text: "ok" }], isError: false, details: { ok: true }, timestamp: 3 },
		{ id: "a2", role: "assistant", ...base, stopReason: "stop", content: [{ type: "text", text: "Thanks." }], timestamp: 4 },
		{ id: "u2", role: "user", content: [{ type: "text", text: "Plan now." }], timestamp: 5 },
	];
	const real = piEngineForSpec({ provider: "anthropic", id: "claude-opus-5-5", thinkingLevel: "off" });
	const payloads: any[] = [];
	const engine = { ...real, streamFn: ((m, c, o) => real.streamFn(m, c, { ...o, onPayload: (value: unknown) => { payloads.push(value); throw new Error("CLOSED: captured payload"); } })) as typeof real.streamFn };
	const ctx = { chatId: record.id, chatStore, jobStore: undefined as never, deliver: () => {}, spawn: () => {}, searchAvailable: false };
	const proberTools = Object.values(createProberTools(ctx as never));
	const teacher = createTeacherAgent(undefined, { engine, messages, sharedHandoff: { proberTools } });
	await teacher.continue();
	const prober = createProberAgent(ctx as never, { engine, messages: messages.slice(0, 3) });
	await prober.continue();
	const [teacherBody, proberBody] = payloads;
	assert.deepEqual(teacherBody.system, proberBody.system, "the prober's instructions stay the system prompt");
	assert.deepEqual(teacherBody.tools, proberBody.tools, "the prober's tools stay the top-level tools");
	const update = teacherBody.messages.find((m: any) => m.role === "system");
	assert(update, "a mid-conversation system message");
	assert.equal(update.content[0].text, `${HANDOFF_UPDATE_TEXT}\n\n${composeInstructions("teacher")}`);
	const additions = update.content.filter((b: any) => b.type === "tool_addition").map((b: any) => b.tool.definition.name);
	const removals = update.content.filter((b: any) => b.type === "tool_removal").map((b: any) => b.tool.name);
	assert.deepEqual(additions.sort(), Object.keys(bareQuestionTools()).filter((name) => !proberTools.some((t) => t.name === name)).sort());
	assert(removals.includes("probe_done"));
	// Anthropic holds a system message until just before the next assistant turn.
	assert.equal(teacherBody.messages.indexOf(update), 3);
	assert.deepEqual(teacherBody.messages.slice(0, 3).map((m: any) => m.role), ["user", "assistant", "user"]);
});
