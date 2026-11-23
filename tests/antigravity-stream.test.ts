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
import { checkAntigravityAgent } from "../src/agent/antigravity/provider.ts";
import { antigravityLimits, createAntigravityStreamFunction } from "../src/agent/antigravity/stream.ts";
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

test("happy path: streamed text, protocolVersion 2 accepted, a mode starting \"auto\" pinned before the prompt, usage mapped", async (t) => {
	const { h, runtime, stream } = setup(t, { protocolVersion: 2, mode: "auto", sessionClose: false, usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2, thoughtTokens: 1 } });
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
	for (const scenario of [{ mode: "auto", modeOptions: ["auto", "plan"] }, { mode: "auto", rejectModeChange: true }, { mode: null }]) {
		const { h, stream } = setup(t, scenario);
		const turn = await collect(stream(PRO, ctx([HI])));
		assert.equal(turn.final.stopReason, "error", JSON.stringify(scenario));
		assert.equal(turn.final.errorMessage, AntigravityMessage.ModeNotSet);
		assert(!h.methods().includes("session/prompt"), JSON.stringify(scenario));
	}
});

test("mode: already `default` sends nothing; legacy `modes` are not read at all (fail closed, even when \"default\")", async (t) => {
	const already = setup(t, { mode: "default", sessionClose: false });
	assert.equal((await collect(already.stream(PRO, ctx([HI])))).final.stopReason, "stop");
	assert.deepEqual(already.h.methods(), ["initialize", "session/new", "session/prompt"]);

	for (const currentModeId of ["default", "auto"]) {
		const legacy = setup(t, { mode: null, sessionClose: false, legacyModes: { currentModeId, availableModes: ["default", "auto"] } });
		const refused = await collect(legacy.stream(PRO, ctx([HI])));
		assert.equal(refused.final.errorMessage, AntigravityMessage.ModeNotSet, currentModeId);
		assert.deepEqual(legacy.h.methods(), ["initialize", "session/new"], "no session/set_mode, no prompt");
	}
});

test("the freshest options decide right before the prompt", async (t) => {
	// A model change reported right after the model was set (an update in the same read) is caught.
	const reverted = setup(t, { revertModelAfterSet: true });
	const turn = await collect(reverted.stream(FLASH, ctx([HI])));
	assert.equal(turn.final.errorMessage, AntigravityMessage.ModelUnavailable);
	assert(!reverted.h.methods().includes("session/prompt"));
	// A model change made while setting the mode is put right by the model step, and confirmed.
	const moved = setup(t, { mode: "auto", modeChangeResetsModel: true });
	assert.equal((await collect(moved.stream(PRO, ctx([HI])))).final.stopReason, "stop");
	assert.deepEqual(sent(moved.h, "session/set_config_option").map((p) => [p.configId, p.value]), [["mode", "default"], ["model", "gemini-3-pro"]]);
});

test("text sent before this turn's prompt is ignored, not shown", async (t) => {
	const { stream } = setup(t, { chunkAfterNew: "SHOULD NOT SHOW " });
	const turn = await collect(stream(PRO, ctx([HI])));
	assert.equal(turn.final.stopReason, "stop");
	assert.equal(turn.text, "Hello world");
});

test("a duplicate session id: turn B fails and never closes or cancels turn A's session", async (t) => {
	const { h, runtime, stream } = setup(t, { fixedSessionId: "dup-session", sessionClose: true, prompt: [{ text: "A " }, { sleepMs: 400 }, { text: "done" }] });
	const a = collect(stream(PRO, ctx([HI])));
	await waitFor(() => h.methods().includes("session/prompt"), 3000, "A prompting");
	const b = await collect(stream(PRO, ctx([HI])));
	assert.equal(b.final.errorMessage, AntigravityMessage.ProtocolError);
	assert(!h.methods().includes("session/close"), "B sent no session/close");
	assert(!h.methods().includes("session/cancel"));
	// "Check connection" on the same process must not close the id A is watching either.
	assert.equal((await checkAntigravityAgent(runtime)).models.length, 2);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert(!h.methods().includes("session/close"), "the check left A's session alone");
	const first = await a;
	assert.equal(first.text, "A done");
	await waitFor(() => h.methods().filter((m) => m === "session/close").length === 1, 3000, "A closes its own session");
});

test("after the model is set, mode and model are re-confirmed from the agent's answer (fail closed)", async (t) => {
	for (const [scenario, message] of [
		[{ modelChangeResetsMode: true }, AntigravityMessage.ModeNotSet],
		[{ rejectModelChange: true }, AntigravityMessage.ModelUnavailable],
		[{ modelSetNoOptions: true }, AntigravityMessage.ModelUnavailable],
	] as const) {
		const { h, stream } = setup(t, scenario);
		const turn = await collect(stream(FLASH, ctx([HI])));
		assert.equal(turn.final.errorMessage, message, JSON.stringify(scenario));
		assert(!h.methods().includes("session/prompt"), JSON.stringify(scenario));
	}
});

test("not signed in on a set_config_option or set_model answer is reported as not signed in", async (t) => {
	for (const scenario of [
		{ mode: "auto", setConfigError: { configId: "mode", code: -32000, message: "Authentication required" } },
		{ setConfigError: { configId: "model", code: -32603, message: "No browser is available here" } },
	]) {
		const { h, stream } = setup(t, scenario);
		const turn = await collect(stream(FLASH, ctx([HI])));
		assert.equal(turn.final.errorMessage, AntigravityMessage.NotSignedIn, JSON.stringify(scenario));
		assert(!h.methods().includes("session/prompt"));
	}
	const refusedValue = setup(t, { mode: "auto", setConfigError: { configId: "mode", code: -32602, message: "Invalid value" } });
	assert.equal((await collect(refusedValue.stream(PRO, ctx([HI])))).final.errorMessage, AntigravityMessage.ModeNotSet);
});

test("a mode change during the reply stops it", async (t) => {
	for (const step of [{ modeUpdate: "auto" }, { configModeUpdate: "accept-edits" }]) {
		const { h, stream } = setup(t, { prompt: [{ text: "Sure." }, step, { waitForCancel: true }] });
		const turn = await collect(stream(PRO, ctx([HI])));
		assert.equal(turn.final.errorMessage, AntigravityMessage.ModeChanged, JSON.stringify(step));
		assert.equal(turn.text, "Sure.");
		await waitFor(() => h.methods().includes("session/cancel"), 3000, "session/cancel");
	}
	const fine = setup(t, { prompt: [{ modeUpdate: "default" }, { text: "ok" }] });
	assert.equal((await collect(fine.stream(PRO, ctx([HI])))).final.stopReason, "stop");
});

test("a tool_call written in the same chunk as the session/new answer still stops the turn; nothing is prompted and the process is killed", async (t) => {
	for (const scenario of [{ toolCallAfterNew: { toolCallId: "early", title: "Run rm", kind: "execute" } }, { permissionAfterNew: true }]) {
		const { h, stream } = setup(t, scenario);
		const turn = await collect(stream(PRO, ctx([HI])));
		assert.equal(turn.final.stopReason, "error", JSON.stringify(scenario));
		assert.equal(turn.final.errorMessage, breachMessage("Run " + ("toolCallAfterNew" in scenario ? "rm" : "ls")));
		assert(!h.methods().includes("session/prompt"));
		assert(!h.methods().includes("session/cancel"), "nothing to cancel during setup");
		await h.assertNoChildren(3000);
	}
});

test("permission request and tool_call in one chunk, either order: the answer is written before session/cancel", async (t) => {
	for (const order of ["permission-first", "tool-first"]) {
		const { h, stream } = setup(t, { prompt: [{ permissionAndToolCall: order }, { waitForCancel: true }] });
		const turn = await collect(stream(PRO, ctx([HI])));
		assert.match(turn.final.errorMessage ?? "", /tried to use one of its own tools/);
		await waitFor(() => h.methods().includes("session/cancel"), 3000, "session/cancel");
		const seen = h.received().map((message) => message.method ?? (typeof message.id === "string" ? "answer" : "other"));
		assert.ok(seen.indexOf("answer") >= 0 && seen.indexOf("answer") < seen.indexOf("session/cancel"), `${order}: ${seen.join(",")}`);
		assert.deepEqual(h.log().find((entry) => entry.kind === "permission-answer")!.answer, { outcome: { outcome: "selected", optionId: "stop-this-command" } });
	}
});

test("no session/cancel for a turn that has already finished", async (t) => {
	const { h, stream } = setup(t, { sessionClose: true, prompt: [{ toolCallWithResult: true }] });
	const turn = await collect(stream(PRO, ctx([HI])));
	assert.equal(turn.final.errorMessage, breachMessage("Late tool"));
	await waitFor(() => h.methods().includes("session/close"), 3000, "session/close");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert(!h.methods().includes("session/cancel"));
});

test("breach labels lose links and control characters; nothing safe left means \"a tool\"", async (t) => {
	const linked = setup(t, { prompt: [{ toolCall: { title: "Fetch https://evil.example/steal?x=1 now", kind: "fetch" } }, { waitForCancel: true }] });
	const turn = await collect(linked.stream(PRO, ctx([HI])));
	assert.equal(turn.final.errorMessage, breachMessage("Fetch now"));
	const bare = setup(t, { prompt: [{ toolCall: { title: "https://evil.example/x", kind: "\u0007" } }, { waitForCancel: true }] });
	const none = await collect(bare.stream(PRO, ctx([HI])));
	assert.equal(none.final.errorMessage, breachMessage("a tool"));
	assert(!JSON.stringify([turn.events, none.events]).includes("evil.example"));
});

test("a setup request with no answer kills the wedged process: did not answer in time", async (t) => {
	antigravityTimeouts.startupMs = 150;
	for (const method of ["session/new", "session/set_config_option"]) {
		const { h, stream } = setup(t, { mode: "auto", hangMethods: [method] });
		const turn = await collect(stream(PRO, ctx([HI])));
		assert.equal(turn.final.errorMessage, AntigravityMessage.AnswerTimeout, method);
		await h.assertNoChildren(3000);
	}
});

test("only text and thinking count as progress: usage updates don't hold off the inactivity stop", async (t) => {
	antigravityTimeouts.inactivityMs = 150;
	antigravityTimeouts.cancelGraceMs = 100;
	const { stream } = setup(t, { prompt: [{ text: "a" }, { usageRepeat: { count: 12, everyMs: 50 } }, { hold: true }] });
	const turn = await collect(stream(PRO, ctx([HI])));
	assert.equal(turn.final.errorMessage, AntigravityMessage.StoppedResponding);
});

test("empty text chunks are not progress either", async (t) => {
	antigravityTimeouts.inactivityMs = 150;
	antigravityTimeouts.cancelGraceMs = 100;
	const { stream } = setup(t, { prompt: [{ text: "a" }, { emptyRepeat: { count: 40, everyMs: 50 } }, { hold: true }] });
	const started = Date.now();
	assert.equal((await collect(stream(PRO, ctx([HI])))).final.errorMessage, AntigravityMessage.StoppedResponding);
	assert.ok(Date.now() - started < 1500, "stopped while the empty chunks (2 s of them) were still arriving");
});

test("the inactivity timer does not keep the server alive", async (t) => {
	const { h, stream } = setup(t, { prompt: [{ text: "a" }, { waitForCancel: true }] });
	const controller = new AbortController();
	const running = collect(stream(PRO, ctx([HI]), { signal: controller.signal }));
	await waitFor(() => h.log().some((entry) => entry.kind === "recv" && entry.line?.includes("session/prompt")), 3000, "prompt open");
	await new Promise((resolve) => setTimeout(resolve, 100));
	const timers = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
	assert.equal(timers, 0, "no ref'd timer while a prompt is open");
	controller.abort();
	await running;
});

test("a reply over the size cap is stopped", async (t) => {
	const { h, stream } = setup(t, { prompt: [{ text: "12345" }, { thought: "678" }, { text: "90abc" }, { waitForCancel: true }] });
	antigravityLimits.replyBytes = 10;
	t.after(() => { antigravityLimits.replyBytes = 4 * 1024 * 1024; });
	const turn = await collect(stream(PRO, ctx([HI])));
	assert.equal(turn.final.errorMessage, AntigravityMessage.TooLong);
	assert.equal(turn.text, "12345");
	await waitFor(() => h.methods().includes("session/cancel"), 3000, "session/cancel");
});

test("a failing model-list save is logged once and never fails the turn", async (t) => {
	const h = mockHarness(t);
	const tempBase = mkdtempSync(join(tmpdir(), "lh-agy-stream-"));
	const runtime = new AntigravityRuntime({ launch: h.launch, tempBase });
	h.onTeardown(() => runtime.shutdown());
	t.after(() => rmSync(tempBase, { recursive: true, force: true }));
	const logged: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
	t.after(() => { console.error = original; });
	const host: AntigravityHost = { available: () => true, models: () => [], saveModels: () => { throw new Error("ENOSPC: no space left on device"); } };
	const stream = createAntigravityStreamFunction({ runtime: () => runtime, host: () => host });
	for (let i = 0; i < 2; i++) assert.equal((await collect(stream(PRO, ctx([HI])))).final.stopReason, "stop");
	assert.deepEqual(logged.filter((line) => line.includes("model list")), ["Antigravity: could not save the model list."]);
	assert(!logged.join("\n").includes("ENOSPC"));
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
		assert.deepEqual(sent(listed.h, "session/set_config_option").map((p) => [p.configId, p.value]), [["model", "gemini-3-flash"]], style);
	}
	// Legacy `models.availableModels` is not read: no model config option fails closed.
	const legacy = setup(t, { models: { style: "legacy" } });
	assert.equal((await collect(legacy.stream(FLASH, ctx([HI])))).final.errorMessage, AntigravityMessage.ModelUnavailable);
	assert(!legacy.h.methods().includes("session/set_model") && !legacy.h.methods().includes("session/prompt"));
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
