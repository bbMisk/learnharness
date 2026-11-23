/**
 * One Antigravity turn (src/agent/antigravity/stream.ts) end to end against
 * the mock agent: system text, replay, approval mode, model choice, tool
 * breaches, cancel, crash, concurrency and stop reasons.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Message } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { AntigravityMessage, breachMessage, TEXT_ONLY_NOTE } from "../src/agent/antigravity/constants.ts";
import type { AntigravityHost } from "../src/agent/antigravity/host.ts";
import { toPiModel, type AgentModel } from "../src/agent/antigravity/models.ts";
import { AntigravityRuntime, antigravityTimeouts } from "../src/agent/antigravity/runtime.ts";
import { createAntigravityStreamFunction } from "../src/agent/antigravity/stream.ts";
import { OMITTED_IMAGE, toAntigravityInput } from "../src/agent/antigravity/transcript.ts";
import { mockHarness, waitFor, type MockHarness, type MockScenario } from "./helpers/antigravity-mock.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

const DEFAULTS = { ...antigravityTimeouts };
const PRO = toPiModel({ id: "gemini-3-pro", name: "Gemini 3 Pro" });
const FLASH = toPiModel({ id: "gemini-3-flash", name: "Gemini 3 Flash" });
const SYSTEM: Message = { role: "system", content: "You are a patient tutor.", timestamp: 0 } as Message;
const HI: Message = { role: "user", content: "hi", timestamp: 0 };
const FAKE_LINK = "Open the following link to authenticate the ACP server: https://example.invalid/fake-sign-in?code=SECRET";

const ctx = (messages: Message[]) => normalizeContext({ messages });

type Turn = { events: AssistantMessageEvent[]; final: AssistantMessage; text: string };

function setup(t: TestContext, scenario: MockScenario = {}, available = true) {
	const h = mockHarness(t, scenario);
	const tempBase = mkdtempSync(join(tmpdir(), "lh-agy-stream-"));
	const runtime = new AntigravityRuntime({ launch: h.launch, tempBase, appVersion: "1.0.0" });
	const saved: AgentModel[][] = [];
	const host: AntigravityHost = { available: () => available, models: () => [], saveModels: (models) => saved.push(models) };
	const stream = createAntigravityStreamFunction({ runtime: () => runtime, host: () => host });
	h.onTeardown(() => runtime.shutdown());
	t.after(() => {
		Object.assign(antigravityTimeouts, DEFAULTS);
		rmSync(tempBase, { recursive: true, force: true });
	});
	return { h, runtime, stream, saved };
}

async function collect(stream: AssistantMessageEventStream): Promise<Turn> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const final = await stream.result();
	const text = final.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
	return { events, final, text };
}

function sent(h: MockHarness, method: string): Record<string, unknown>[] {
	return h.received().filter((message) => message.method === method).map((message) => message.params as Record<string, unknown>);
}

test("happy path: streamed text, protocolVersion 2 accepted, mode pinned before the prompt, usage mapped", async (t) => {
	const { h, runtime, stream } = setup(t, { usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2, thoughtTokens: 1 } });
	const turn = await collect(stream(PRO, ctx([SYSTEM, HI])));
	assert.equal(turn.final.stopReason, "stop");
	assert.equal(turn.text, "Hello world");
	assert.deepEqual(turn.events.map((e) => e.type), ["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
	assert.deepEqual(turn.final.usage, { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
	assert.deepEqual(h.methods(), ["initialize", "session/new", "session/set_config_option", "session/prompt"]);
	assert.deepEqual(sent(h, "session/set_config_option")[0], { sessionId: sent(h, "session/prompt")[0]!.sessionId, configId: "mode", value: "default" });
	const created = sent(h, "session/new")[0]!;
	assert.deepEqual(created.mcpServers, []);
	assert.equal(created.cwd, runtime.connection!.workspace);
});

test("system text goes in _meta when advertised and as the first prompt block when not", async (t) => {
	const conversation: Message[] = [SYSTEM, HI, { role: "assistant", content: [{ type: "text", text: "Hello!" }], api: "x", provider: "x", model: "x", usage: PRO_USAGE(), stopReason: "stop", timestamp: 0 }, { role: "user", content: "next", timestamp: 0 }];
	const { transcript } = toAntigravityInput(conversation);
	const systemText = `${TEXT_ONLY_NOTE}\n\nYou are a patient tutor.`;

	const advertised = setup(t, { systemPromptAppend: true });
	assert.equal((await collect(advertised.stream(PRO, ctx(conversation)))).final.stopReason, "stop");
	assert.deepEqual(sent(advertised.h, "session/new")[0]!._meta, { antigravity: { systemPrompt: { append: systemText } } });
	assert.deepEqual(sent(advertised.h, "session/prompt")[0]!.prompt, [{ type: "text", text: transcript }]);

	const plain = setup(t, { systemPromptAppend: false });
	assert.equal((await collect(plain.stream(PRO, ctx(conversation)))).final.stopReason, "stop");
	assert.equal(sent(plain.h, "session/new")[0]!._meta, undefined);
	assert.deepEqual(sent(plain.h, "session/prompt")[0]!.prompt, [{ type: "text", text: systemText }, { type: "text", text: transcript }]);
});

function PRO_USAGE() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

test("replay: labelled transcript, images become placeholders, thinking is dropped", () => {
	const messages: Message[] = [
		SYSTEM,
		{ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 0 },
		{ role: "assistant", content: [{ type: "thinking", thinking: "secret reasoning" }, { type: "text", text: "Let me look." }, { type: "toolCall", id: "c1", name: "read_page", arguments: { page: 2 } }], api: "x", provider: "x", model: "x", usage: PRO_USAGE(), stopReason: "toolUse", timestamp: 0 },
		{ role: "toolResult", toolCallId: "c1", toolName: "read_page", content: [{ type: "text", text: "Page two" }, { type: "image", data: "BBBB", mimeType: "image/png" }], isError: false, timestamp: 0 },
		{ role: "toolResult", toolCallId: "c2", toolName: "quiz", content: [{ type: "text", text: "failed" }], isError: true, timestamp: 0 },
	];
	const input = toAntigravityInput(messages);
	assert.equal(input.systemText, `${TEXT_ONLY_NOTE}\n\nYou are a patient tutor.`);
	assert.equal(input.transcript, [
		`[user]\nWhat is this?\n${OMITTED_IMAGE}`,
		"[assistant]\nLet me look.",
		'[tool call read_page] {"page":2}',
		`[tool result read_page]\nPage two\n${OMITTED_IMAGE}`,
		"[tool result quiz error]\nfailed",
	].join("\n\n"));
	assert(!input.transcript.includes("secret reasoning"));
	assert.equal(toAntigravityInput([HI]).transcript, "hi", "a first message goes in unlabelled");
	assert.equal(toAntigravityInput([HI]).systemText, TEXT_ONLY_NOTE);
});

test("mode: no `default` on offer → the turn fails and no prompt is sent", async (t) => {
	for (const scenario of [{ modeOptions: ["auto", "plan"] }, { rejectModeChange: true }, { mode: null }]) {
		const { h, stream } = setup(t, scenario);
		const turn = await collect(stream(PRO, ctx([HI])));
		assert.equal(turn.final.stopReason, "error", JSON.stringify(scenario));
		assert.equal(turn.final.errorMessage, AntigravityMessage.ModeNotSet);
		assert(!h.methods().includes("session/prompt"), JSON.stringify(scenario));
	}
});

test("mode: already `default` sends nothing; legacy modes use session/set_mode", async (t) => {
	const already = setup(t, { mode: "default" });
	assert.equal((await collect(already.stream(PRO, ctx([HI])))).final.stopReason, "stop");
	assert.deepEqual(already.h.methods(), ["initialize", "session/new", "session/prompt"]);

	const legacy = setup(t, { mode: null, legacyModes: { currentModeId: "auto", availableModes: ["default", "auto"] } });
	assert.equal((await collect(legacy.stream(PRO, ctx([HI])))).final.stopReason, "stop");
	assert.deepEqual(legacy.h.methods(), ["initialize", "session/new", "session/set_mode", "session/prompt"]);
	assert.equal(sent(legacy.h, "session/set_mode")[0]!.modeId, "default");
});

test("permission request → reject_once chosen, breach error, session/cancel sent, streamed text kept", async (t) => {
	const { h, stream } = setup(t, { prompt: [{ text: "Let me check." }, { permission: { title: "Run ls" } }, { text: "never" }] });
	const turn = await collect(stream(PRO, ctx([HI])));
	assert.equal(turn.final.stopReason, "error");
	assert.equal(turn.final.errorMessage, breachMessage("Run ls"));
	assert.equal(turn.text, "Let me check.");
	await waitFor(() => h.log().some((entry) => entry.kind === "permission-answer"), 3000, "permission answer");
	assert.deepEqual(h.log().find((entry) => entry.kind === "permission-answer")!.answer, { outcome: { outcome: "selected", optionId: "stop-this-command" } });
	await waitFor(() => h.methods().includes("session/cancel"), 3000, "session/cancel");
	const cancel = h.received().find((message) => message.method === "session/cancel")!;
	assert.equal("id" in cancel, false, "session/cancel is a notification");
	const order = h.received().map((message) => message.method ?? (message.id === "mock-1" ? "permission-answer" : "other"));
	assert.ok(order.indexOf("permission-answer") >= 0 && order.indexOf("permission-answer") < order.indexOf("session/cancel"), "the reject answer is written before session/cancel");
});

test("a bare tool_call is a breach too; fs/read_text_file is answered -32601 and is not", async (t) => {
	const bare = setup(t, { prompt: [{ toolCall: { toolCallId: "c1", title: "Read notes.md", kind: "read", status: "pending" } }, { waitForCancel: true }] });
	const turn = await collect(bare.stream(PRO, ctx([HI])));
	assert.equal(turn.final.errorMessage, breachMessage("Read notes.md"));
	await waitFor(() => bare.h.methods().includes("session/cancel"), 3000, "session/cancel");

	const fs = setup(t, { prompt: [{ fsRead: true }, { text: "done" }] });
	const ok = await collect(fs.stream(PRO, ctx([HI])));
	assert.equal(ok.final.stopReason, "stop");
	assert.equal(ok.text, "done");
	assert.deepEqual((fs.h.log().find((entry) => entry.kind === "fs-answer")!.answer as { error: unknown }).error, { code: -32601, message: "Method not found: fs/read_text_file" });
});

test("model: unknown → isn't available, no prompt; a listed other model → set_config_option", async (t) => {
	const unknown = setup(t);
	const missing = await collect(unknown.stream(toPiModel({ id: "gemini-9", name: "x" }), ctx([HI])));
	assert.equal(missing.final.errorMessage, AntigravityMessage.ModelUnavailable);
	assert(!unknown.h.methods().includes("session/prompt"));

	for (const style of ["flat", "grouped"]) {
		const listed = setup(t, { models: { style } });
		assert.equal((await collect(listed.stream(FLASH, ctx([HI])))).final.stopReason, "stop");
		assert.deepEqual(sent(listed.h, "session/set_config_option").map((p) => [p.configId, p.value]), [["mode", "default"], ["model", "gemini-3-flash"]], style);
	}
	const legacy = setup(t, { models: { style: "legacy" } });
	assert.equal((await collect(legacy.stream(FLASH, ctx([HI])))).final.stopReason, "stop");
	assert.deepEqual(sent(legacy.h, "session/set_model"), [{ sessionId: sent(legacy.h, "session/prompt")[0]!.sessionId, modelId: "gemini-3-flash" }]);
});

test("cancel honoured: the stream ends aborted at once, session/cancel sent, the process survives", async (t) => {
	const { h, runtime, stream } = setup(t, { prompt: [{ text: "partial" }, { waitForCancel: true }] });
	const controller = new AbortController();
	const running = collect(stream(PRO, ctx([HI]), { signal: controller.signal }));
	await waitFor(() => (runtime.connection !== undefined) && h.methods().includes("session/prompt"), 3000, "prompt open");
	await waitFor(() => h.log().filter((e) => e.kind === "recv").length > 0, 3000, "log");
	await new Promise((resolve) => setTimeout(resolve, 50));
	controller.abort();
	const turn = await running;
	assert.equal(turn.final.stopReason, "aborted");
	assert.equal(turn.text, "partial");
	await waitFor(() => h.methods().includes("session/cancel"), 3000, "session/cancel");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(runtime.connection?.alive, true, "a honoured cancel needs no kill");
});

test("cancel ignored → kill escalation; the stream still ends aborted and the next turn respawns", async (t) => {
	antigravityTimeouts.cancelGraceMs = 150;
	antigravityTimeouts.killGraceMs = 100;
	const { h, stream } = setup(t, { ignoreCancel: true, ignoreTerm: true, prompt: [{ text: "partial" }, { hold: true }] });
	const controller = new AbortController();
	const running = collect(stream(PRO, ctx([HI]), { signal: controller.signal }));
	await waitFor(() => h.methods().includes("session/prompt"), 3000, "prompt open");
	controller.abort();
	assert.equal((await running).final.stopReason, "aborted");
	await h.assertNoChildren(3000);
	assert.equal(h.children[0]!.signalCode, "SIGKILL");
	h.setScenario({});
	assert.equal((await collect(stream(PRO, ctx([HI])))).final.stopReason, "stop");
	assert.equal(h.spawns, 2);
});

test("already aborted, or provider unavailable: nothing is spawned", async (t) => {
	const aborted = setup(t);
	const controller = new AbortController();
	controller.abort();
	assert.equal((await collect(aborted.stream(PRO, ctx([HI]), { signal: controller.signal }))).final.stopReason, "aborted");
	const off = setup(t, {}, false);
	const turn = await collect(off.stream(PRO, ctx([HI])));
	assert.equal(turn.final.errorMessage, AntigravityMessage.Off);
	assert.equal(aborted.h.spawns + off.h.spawns, 0);
});

test("inactivity: no update for the timeout → stopped responding, cancel, then kill", async (t) => {
	antigravityTimeouts.inactivityMs = 150;
	antigravityTimeouts.cancelGraceMs = 100;
	const { h, stream } = setup(t, { prompt: [{ text: "partial" }, { hold: true }] });
	const turn = await collect(stream(PRO, ctx([HI])));
	assert.equal(turn.final.errorMessage, AntigravityMessage.StoppedResponding);
	await waitFor(() => h.methods().includes("session/cancel"), 3000, "session/cancel");
	await h.assertNoChildren(3000);
});

test("crash mid-turn with two turns in flight: both error, neither hangs, the next turn respawns", async (t) => {
	const { h, stream } = setup(t, { prompt: [{ text: "partial" }, { hold: true }] });
	const turns = [collect(stream(PRO, ctx([HI]))), collect(stream(PRO, ctx([HI])))];
	await waitFor(() => h.methods().filter((m) => m === "session/prompt").length === 2, 3000, "two prompts open");
	h.children[0]!.kill("SIGKILL");
	for (const turn of await Promise.all(turns)) {
		assert.equal(turn.final.stopReason, "error");
		assert.equal(turn.final.errorMessage, AntigravityMessage.Exited);
	}
	h.setScenario({});
	assert.equal((await collect(stream(PRO, ctx([HI])))).final.stopReason, "stop");
	assert.equal(h.spawns, 2);
});

test("two concurrent turns never receive each other's chunks", async (t) => {
	const { stream } = setup(t, { prompt: [{ echo: true }, { echo: true }, { echo: true }] });
	const [a, b] = await Promise.all([
		collect(stream(PRO, ctx([{ role: "user", content: "AAA", timestamp: 0 }]))),
		collect(stream(PRO, ctx([{ role: "user", content: "BBB", timestamp: 0 }]))),
	]);
	assert.equal(a.text, "echo:AAA".repeat(3));
	assert.equal(b.text, "echo:BBB".repeat(3));
});

test("stop reasons: max_tokens, refusal, max_turn_requests; thinking streams as thinking", async (t) => {
	const length = setup(t, { stopReason: "max_tokens", prompt: [{ thought: "hmm" }, { text: "cut" }] });
	const cut = await collect(length.stream(PRO, ctx([HI])));
	assert.equal(cut.final.stopReason, "length");
	assert.deepEqual(cut.final.content.map((block) => block.type), ["thinking", "text"]);
	assert.deepEqual(cut.events.map((e) => e.type), ["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done"]);
	const refusal = setup(t, { stopReason: "refusal" });
	assert.equal((await collect(refusal.stream(PRO, ctx([HI])))).final.errorMessage, AntigravityMessage.Refusal);
	const turns = setup(t, { stopReason: "max_turn_requests" });
	assert.equal((await collect(turns.stream(PRO, ctx([HI])))).final.errorMessage, "Antigravity stopped early (max_turn_requests).");
});

test("not signed in through a turn: one fixed message, and the link appears in no event", async (t) => {
	for (const scenario of [{ initializeError: { code: -32000, message: "Authentication required" } }, { sessionNewError: { code: -32603, message: "No browser is available here https://example.invalid/x" } }, { stdoutAtStart: [FAKE_LINK] }]) {
		const { stream } = setup(t, scenario);
		const turn = await collect(stream(PRO, ctx([HI])));
		assert.equal(turn.final.errorMessage, AntigravityMessage.NotSignedIn, JSON.stringify(scenario));
		assert(!JSON.stringify(turn.events).includes("example.invalid"));
	}
	const { stream } = setup(t, { sessionNewError: { code: -32603, message: "SUBSCRIPTION_REQUIRED" } });
	assert.equal((await collect(stream(PRO, ctx([HI])))).final.errorMessage, AntigravityMessage.NoSubscription);
});

test("session/new refreshes the model list; session/close is sent when advertised", async (t) => {
	const { h, stream, saved } = setup(t, { sessionClose: true });
	assert.equal((await collect(stream(PRO, ctx([HI])))).final.stopReason, "stop");
	assert.deepEqual(saved, [[{ id: "gemini-3-pro", name: "Gemini 3 Pro" }, { id: "gemini-3-flash", name: "Gemini 3 Flash" }]]);
	await waitFor(() => h.methods().includes("session/close"), 3000, "session/close");
});

test("idle kill: a turn holds the process past the idle timeout, and it stops once the turn ends", async (t) => {
	antigravityTimeouts.idleMs = 150;
	const { h, runtime, stream } = setup(t, { prompt: [{ text: "slow" }, { sleepMs: 400 }, { text: " reply" }] });
	const turn = await collect(stream(PRO, ctx([HI])));
	assert.equal(turn.final.stopReason, "stop");
	assert.equal(turn.text, "slow reply", "never killed mid-prompt");
	assert.equal(h.spawns, 1);
	await h.assertNoChildren(3000);
	assert.equal(runtime.connection, undefined);
});
