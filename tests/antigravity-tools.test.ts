/**
 * LearnHarness tools on Antigravity lessons (docs/antigravity.md): the agent calls the lesson's
 * declared tools through the loopback MCP bridge; LearnHarness runs them through pi. The mock
 * agent is a real MCP client of the bridge (tests/fixtures/antigravity/mock-agy.mjs), built from
 * the lead's scrubbed frames of agy 1.5.15. Every assertion reads the mock's log.
 */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AssistantMessage, Message, Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { AntigravityMessage, TEXT_ONLY_NOTE, TOOLS_NOTE, toolBreachMessage, breachMessage } from "../src/agent/antigravity/constants.ts";
import { toPiModel } from "../src/agent/antigravity/models.ts";
import { AntigravityRuntime, antigravityTimeouts } from "../src/agent/antigravity/runtime.ts";
import { createAntigravityStreamFunction, expireWaitingTurns, parkedSessionCount, toolBridgeOf, waitingTurnCount } from "../src/agent/antigravity/stream.ts";
import { ToolBridge } from "../src/agent/antigravity/tool-bridge.ts";
import { mockHarness, waitFor, type MockScenario } from "./helpers/antigravity-mock.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

const DEFAULTS = { ...antigravityTimeouts };
const ECHO: Tool = { name: "lh_echo", description: "Echo text", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } as Tool["parameters"] };
const IMAGE: Tool = { name: "lh_image", description: "A test image", parameters: { type: "object", properties: {} } as Tool["parameters"] };
const PRO = toPiModel({ id: "gemini-3-pro", name: "Gemini 3 Pro", levels: ["low", "medium", "high"] });
const SYSTEM_TEXT = "You are a patient tutor.";
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const say = (text: string) => ({ text });
const call = (name: string, extra: Record<string, unknown> = {}) => ({ mcpCall: { name, arguments: name === "lh_echo" ? { text: "hello" } : {}, ...extra } });
const PNG = "iVBORw0KGgo=";

function base(t: TestContext, scenario: MockScenario = {}) {
	const previous = { tools: process.env.LH_ANTIGRAVITY_TOOLS, reuse: process.env.LH_ANTIGRAVITY_REUSE };
	t.after(() => {
		for (const [name, value] of [["LH_ANTIGRAVITY_TOOLS", previous.tools], ["LH_ANTIGRAVITY_REUSE", previous.reuse]] as const) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
	});
	// These tests are about tools ON (and reuse on) unless they say otherwise.
	delete process.env.LH_ANTIGRAVITY_TOOLS;
	delete process.env.LH_ANTIGRAVITY_REUSE;
	const h = mockHarness(t, { sessionClose: true, ...scenario });
	const tempBase = mkdtempSync(join(tmpdir(), "lh-agy-tools-"));
	const runtime = new AntigravityRuntime({ launch: h.launch, tempBase });
	h.onTeardown(() => runtime.shutdown());
	t.after(() => { Object.assign(antigravityTimeouts, DEFAULTS); rmSync(tempBase, { recursive: true, force: true }); });
	return { h, runtime };
}

type Exec = (call: ToolCall) => Promise<{ content: ToolResultMessage["content"]; isError?: boolean }>;
const echoExec: Exec = async (c) => ({ content: [{ type: "text", text: `ECHO:${String(c.arguments.text ?? "")}` }] });

/**
 * The tools half of pi: run the stream; while it ends with "toolUse", run the call and stream again
 * with the assistant message and the result appended, under the same chat key.
 */
function setup(t: TestContext, scenario: MockScenario = {}) {
	const { h, runtime } = base(t, scenario);
	const stream = createAntigravityStreamFunction({ runtime: () => runtime, host: () => ({ available: () => true, models: () => [], saveModels: () => {} }) });
	const once = async (convo: Message[], tools: Tool[], options: { sessionId?: string; signal?: AbortSignal } = {}) => {
		const events = stream(PRO, normalizeContext({ systemPrompt: SYSTEM_TEXT, messages: convo, tools }), { sessionId: "sessionId" in options ? options.sessionId : "chat-1", ...(options.signal ? { signal: options.signal } : {}) });
		for await (const _event of events) { /* drain */ }
		return events.result();
	};
	const lesson = async (convo: Message[], tools: Tool[], exec: Exec = echoExec, options: { sessionId?: string; signal?: AbortSignal; maxRounds?: number } = {}) => {
		const messages = [...convo];
		const finals: AssistantMessage[] = [];
		for (let round = 0; round < (options.maxRounds ?? 10); round++) {
			const reply = await once(messages, tools, options);
			finals.push(reply);
			messages.push(reply);
			if (reply.stopReason !== "toolUse") break;
			const toolCall = reply.content.find((block): block is ToolCall => block.type === "toolCall")!;
			const result = await exec(toolCall);
			messages.push({ role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name, content: result.content, isError: result.isError ?? false, timestamp: 0 });
		}
		return { messages, finals, last: finals.at(-1)! };
	};
	const entries = <T = Record<string, unknown>>(kind: string) => h.log().filter((entry) => entry.kind === kind) as unknown as T[];
	const prompts = () => entries<{ sessionId: string; n: number; texts: string[] }>("prompt");
	const sent = (method: string) => h.received().filter((m) => m.method === method);
	const textOf = (message: AssistantMessage) => message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
	/** The system text each fresh session got (the agent's system prompt append). */
	const systemTexts = () => sent("session/new").map((m) => String((m.params as { _meta?: { antigravity?: { systemPrompt?: { append?: string } } } })._meta?.antigravity?.systemPrompt?.append));
	return { h, runtime, stream, once, lesson, entries, prompts, sent, textOf, systemTexts };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the mock connects to the bridge during session/new like the real agent, and disconnects on session/close", async (t) => {
	const { h, runtime } = base(t);
	const bridge = await ToolBridge.start();
	t.after(() => bridge.close());
	const endpoint = await bridge.open([ECHO], { onCall: () => true, onAbort: () => {}, onInvalid: () => {} });
	const connection = await runtime.connect();
	const created = await connection.request("session/new", { cwd: connection.workspace, mcpServers: [endpoint.mcpServer] }) as { sessionId: string };
	const log = h.log();
	assert.deepEqual(log.filter((e) => e.kind === "well-known").map((e) => (e as unknown as { status: number }).status), [404, 404], "probed without the header, answered 404");
	assert.deepEqual(log.filter((e) => e.kind === "mcp-tools").map((e) => (e as unknown as { names: string[] }).names), [["lh_echo"]]);
	await connection.request("session/close", { sessionId: created.sessionId });
	await waitFor(() => h.log().some((e) => e.kind === "mcp-closed"), 3000, "the mock's MCP client to close");
});

test("one tool round: the call becomes pi's tool call, the result goes back, and the reply continues on the same ACP prompt", async (t) => {
	const s = setup(t, { prompt: [say("Let me check. "), call("lh_echo", { echo: true }), say(" Done.")] });
	const { finals, last } = await s.lesson([user("Echo hello")], [ECHO]);
	assert.deepEqual(finals.map((m) => m.stopReason), ["toolUse", "stop"]);
	const toolCall = finals[0]!.content.find((block) => block.type === "toolCall") as ToolCall;
	assert.deepEqual([toolCall.name, toolCall.arguments], ["lh_echo", { text: "hello" }], "the plain name and the real arguments (no toolSummary)");
	assert.equal(s.textOf(finals[0]!), "Let me check. ");
	assert.equal(s.textOf(last), "tool said: ECHO:hello Done.");
	assert.equal(s.sent("session/new").length, 1);
	assert.equal(s.prompts().length, 1, "one ACP prompt across both pi streams");
	const newParams = s.sent("session/new")[0]!.params as { mcpServers: { name: string; url: string }[] };
	assert.equal(newParams.mcpServers.length, 1);
	assert.match(newParams.mcpServers[0]!.name, /^lh[0-9a-f]{10}$/, "the session's own server name");
	assert.deepEqual(s.systemTexts(), [`${TOOLS_NOTE}\n\n${SYSTEM_TEXT}`]);
	assert.deepEqual(s.entries<{ answer: unknown }>("permission-answer").map((e) => e.answer), [{ outcome: { outcome: "selected", optionId: "allow" } }]);
	assert.deepEqual(s.entries<{ result: unknown }>("mcp-result").map((e) => e.result), [{ content: [{ type: "text", text: "ECHO:hello" }], isError: false }]);
	assert.equal(waitingTurnCount(s.runtime.connection!), 0);
	assert.equal(parkedSessionCount(s.runtime.connection!), 1, "a clean tool turn is parked");
});

test("an image result reaches the agent as an MCP image block", async (t) => {
	const s = setup(t, { prompt: [call("lh_image"), say("red")] });
	const { last } = await s.lesson([user("What colour?")], [ECHO, IMAGE], async () => ({ content: [{ type: "text", text: "here" }, { type: "image", data: PNG, mimeType: "image/png" }] }));
	assert.equal(last.stopReason, "stop");
	assert.deepEqual(s.entries<{ result: unknown }>("mcp-result").map((e) => e.result), [{ content: [{ type: "text", text: "here" }, { type: "image", data: PNG, mimeType: "image/png" }], isError: false }]);
});

test("two calls in one step run as two serial rounds; several rounds share one prompt", async (t) => {
	const s = setup(t, { prompt: [call("lh_echo"), call("lh_image"), say("between "), call("lh_echo"), say("end")] });
	const { finals, last } = await s.lesson([user("go")], [ECHO, IMAGE]);
	assert.deepEqual(finals.map((m) => m.stopReason), ["toolUse", "toolUse", "toolUse", "stop"]);
	assert.equal(s.textOf(last), "end");
	assert.equal(s.prompts().length, 1);
	const order = s.h.log().filter((e) => e.kind === "permission-answer" || e.kind === "mcp-result").map((e) => `${e.kind}:${(e as unknown as { name: string }).name.replace(/^mcp_lh[0-9a-f]{10}_/, "mcp_<ours>_")}`);
	assert.deepEqual(order, ["permission-answer:mcp_<ours>_lh_echo", "mcp-result:lh_echo", "permission-answer:mcp_<ours>_lh_image", "mcp-result:lh_image", "permission-answer:mcp_<ours>_lh_echo", "mcp-result:lh_echo"]);
});

test("a second MCP call while one is held is refused and the turn expires; the result then gets a fresh session with the full replay", async (t) => {
	const s = setup(t, { promptSeq: [[{ mcpWhileHeld: { first: call("lh_echo").mcpCall, second: { name: "lh_echo", arguments: { text: "again" } } } }, say("never")], [say("Fresh reply")]] });
	const { finals, last } = await s.lesson([user("go")], [ECHO], async (c) => { await waitFor(() => s.sent("session/cancel").length === 1, 5000, "expiry"); return echoExec(c); });
	assert.deepEqual(finals.map((m) => m.stopReason), ["toolUse", "stop"]);
	assert.equal(s.textOf(last), "Fresh reply");
	const raw = s.entries<{ raw?: boolean; result: { isError?: boolean; error?: string } }>("mcp-result").find((e) => e.raw);
	assert.ok(raw && (raw.result.isError || raw.result.error), "the second call was refused");
	assert.equal(s.sent("session/cancel").length, 1);
	assert.equal(s.sent("session/new").length, 2);
	const [first, second] = s.prompts();
	assert.notEqual(first!.sessionId, second!.sessionId);
	assert.match(second!.texts.join("\n"), /\[tool call lh_echo\] \{"text":"hello"\}/);
	assert.match(second!.texts.join("\n"), /\[tool result lh_echo\]\nECHO:hello/);
	assert.ok(s.sent("session/close").some((m) => (m.params as { sessionId: string }).sessionId === first!.sessionId), "the expired session was closed");
});

test("permission: ours selects allow_once (never allow_always); an undeclared mcp_learnharness_ tool, a built-in tool, or no allow_once option is rejected and stops the reply", async (t) => {
	const always = [{ optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "once", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Deny", kind: "reject_once" }];
	const ok = setup(t, { prompt: [call("lh_echo", { options: always }), say("fine")] });
	assert.equal((await ok.lesson([user("go")], [ECHO])).last.stopReason, "stop");
	assert.deepEqual(ok.entries<{ answer: unknown }>("permission-answer").map((e) => e.answer), [{ outcome: { outcome: "selected", optionId: "once" } }]);
	const cases: [string, Record<string, unknown>][] = [
		["undeclared", call("lh_x", { agentName: "mcp_{server}_lh_x" })],
		["built-in", call("lh_echo", { agentName: "run_command" })],
		["no allow_once", call("lh_echo", { options: [always[0], always[2]] })],
	];
	for (const [what, step] of cases) {
		await t.test(what, async (tt) => {
			const s = setup(tt, { prompt: [step, say("never")] });
			const { last } = await s.lesson([user("go")], [ECHO]);
			assert.equal(last.stopReason, "error", what);
			assert.match(last.errorMessage ?? "", /^Antigravity tried to use a tool LearnHarness didn't give it/);
			if (what === "undeclared") assert.equal(last.errorMessage, toolBreachMessage("lh_x"), "our server segment: the plain tool name");
			await waitFor(() => s.entries("permission-answer").length === 1, 3000, "the answer to reach the mock");
			assert.deepEqual(s.entries<{ answer: unknown }>("permission-answer").map((e) => e.answer), [{ outcome: { outcome: "selected", optionId: what === "no allow_once" ? "no" : "deny" } }]);
			assert.equal(s.entries("mcp-result").length, 0, "nothing was called");
		});
	}
	assert.equal(toolBreachMessage("x").includes("x"), true);
});

test("MCP: a bad token or path is refused with no call; an undeclared tool or an unannounced call is refused and stops the reply", async (t) => {
	const bad = setup(t, { prompt: [{ mcpBadAuth: true }, say("still fine")] });
	assert.equal((await bad.lesson([user("go")], [ECHO])).last.stopReason, "stop");
	assert.deepEqual(bad.entries<{ wrongToken: number; wrongPath: number }>("mcp-bad-auth").map((e) => [e.wrongToken, e.wrongPath]), [[401, 404]]);
	for (const [what, name] of [["undeclared", "nope"], ["unannounced", "lh_echo"]] as const) {
		await t.test(what, async (tt) => {
			const s = setup(tt, { prompt: [{ mcpRaw: { name, arguments: { text: "x" } } }, say("never")] });
			const { last } = await s.lesson([user("go")], [ECHO]);
			assert.equal(last.stopReason, "error");
			assert.equal(last.errorMessage, AntigravityMessage.UnexpectedToolCall);
			await waitFor(() => s.sent("session/cancel").length === 1, 3000, "the cancel");
		});
	}
});

test("a late result: the waiting turn expires at the deadline (cancel + close), then the result starts a fresh session with the labelled call and result", async (t) => {
	const s = setup(t, { promptSeq: [[call("lh_echo"), say("never")], [say("Continuing the lesson")]] });
	antigravityTimeouts.toolWaitMs = 200;
	const { finals, last } = await s.lesson([user("go")], [ECHO], async (c) => {
		await waitFor(() => s.sent("session/close").length === 1, 3000, "expiry");
		return echoExec(c);
	});
	assert.deepEqual(finals.map((m) => m.stopReason), ["toolUse", "stop"]);
	assert.equal(s.textOf(last), "Continuing the lesson");
	assert.equal(s.sent("session/cancel").length, 1);
	assert.equal(s.prompts().length, 2);
	assert.match(s.prompts()[1]!.texts.join("\n"), /\[tool call lh_echo\][\s\S]*\[tool result lh_echo\]\nECHO:hello/);
	assert.deepEqual(s.entries<{ result: { error?: string; isError?: boolean } }>("mcp-result").map((e) => !!(e.result.error || e.result.isError)), [true], "the held call ended without a result");
});

test("the agent cancelling a held call itself expires the turn", async (t) => {
	const s = setup(t, { promptSeq: [[call("lh_echo", { cancelAfterMs: 100 }), say("never")], [say("Fresh")]] });
	const { last } = await s.lesson([user("go")], [ECHO], async (c) => { await waitFor(() => s.sent("session/cancel").length === 1, 3000, "expiry"); return echoExec(c); });
	assert.equal(s.textOf(last), "Fresh");
	assert.equal(s.sent("session/new").length, 2);
});

test("the process dying while a call waits: the result runs on a fresh process with the replay", async (t) => {
	const s = setup(t, { prompt: [call("lh_echo"), say("never")] });
	const { last } = await s.lesson([user("go")], [ECHO], async (c) => {
		s.h.setScenario({ sessionClose: true, prompt: [say("Fresh")] }); // what the next process does
		s.h.children[0]!.kill("SIGKILL");
		await waitFor(() => s.runtime.connection === undefined, 3000, "the process to die");
		return echoExec(c);
	});
	assert.equal(s.textOf(last), "Fresh");
	assert.equal(s.h.spawns, 2);
	assert.match(s.prompts().at(-1)!.texts.join("\n"), /\[tool result lh_echo\]/);
});

test("a result that does not match (other id, changed history, an extra message) expires the turn and takes the fresh path", async (t) => {
	const variants: [string, (messages: Message[]) => Message[]][] = [
		["other id", (m) => m.map((x) => (x.role === "toolResult" ? { ...x, toolCallId: "other" } : x))],
		["changed history", (m) => [user("a different question"), ...m.slice(1)]],
		["extra message", (m) => [...m, user("and also")]],
	];
	for (const [what, change] of variants) {
		await t.test(what, async (tt) => {
			const s = setup(tt, { promptSeq: [[call("lh_echo"), say("never")]], prompt: [say("Fresh")] });
			const first = await s.once([user("go")], [ECHO]);
			assert.equal(first.stopReason, "toolUse");
			const toolCall = first.content.find((b) => b.type === "toolCall") as ToolCall;
			const messages = change([user("go"), first, { role: "toolResult", toolCallId: toolCall.id, toolName: "lh_echo", content: [{ type: "text", text: "ECHO:hello" }], isError: false, timestamp: 0 }]);
			const next = await s.once(messages, [ECHO]);
			assert.equal(s.textOf(next), "Fresh");
			assert.equal(s.sent("session/cancel").length, 1, "the waiting turn was cancelled");
			assert.equal(s.sent("session/new").length, 2);
			assert.equal(waitingTurnCount(s.runtime.connection!), 0);
		});
	}
});

test("Stop while a tool waits cancels the held prompt and closes the session; Stop on a resumed stream cancels it", async (t) => {
	const s = setup(t, { promptSeq: [[call("lh_echo"), say("never")], [call("lh_echo"), { waitForCancel: true }]] });
	const controller = new AbortController();
	const first = await s.once([user("go")], [ECHO], { signal: controller.signal });
	assert.equal(first.stopReason, "toolUse");
	controller.abort();
	await waitFor(() => s.sent("session/close").length === 1, 3000, "the session to close");
	assert.equal(s.sent("session/cancel").length, 1);
	assert.equal(waitingTurnCount(s.runtime.connection!), 0);
	// The second prompt: resumed, then Stop while it streams.
	const again = await s.once([user("go again")], [ECHO], { sessionId: "chat-2" });
	const toolCall = again.content.find((b) => b.type === "toolCall") as ToolCall;
	const stop = new AbortController();
	const resumed = s.once([user("go again"), again, { role: "toolResult", toolCallId: toolCall.id, toolName: "lh_echo", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 }], [ECHO], { sessionId: "chat-2", signal: stop.signal });
	await waitFor(() => s.entries("mcp-result").length === 2, 3000, "the result to reach the agent");
	stop.abort();
	assert.equal((await resumed).stopReason, "aborted");
	await waitFor(() => s.sent("session/cancel").length === 2, 3000, "the resumed prompt to be cancelled");
});

test("while waiting: a text chunk or a foreign tool update expires the turn; the held call's own late in_progress update does not", async (t) => {
	const late = setup(t, { prompt: [call("lh_echo", { lateInProgress: true }), say("ok")] });
	assert.equal((await late.lesson([user("go")], [ECHO], async (c) => { await delay(100); return echoExec(c); })).last.stopReason, "stop");
	assert.equal(late.prompts().length, 1, "resumed on the same prompt");
	for (const [what, body] of [
		["text", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "while held" } }],
		["tool", { sessionUpdate: "tool_call", toolCallId: "x", name: "run_command", title: "Run", kind: "execute" }],
		["mode", { sessionUpdate: "current_mode_update", currentModeId: "auto" }],
	] as const) {
		await t.test(what, async (tt) => {
			const s = setup(tt, { promptSeq: [[call("lh_echo", { whileHeld: [body] }), say("never")]], prompt: [say("Fresh")] });
			const { last } = await s.lesson([user("go")], [ECHO], async (c) => { await waitFor(() => s.sent("session/cancel").length === 1, 3000, "expiry"); return echoExec(c); });
			assert.equal(s.textOf(last), "Fresh");
			assert.equal(s.sent("session/new").length, 2);
		});
	}
	const usage = setup(t, { prompt: [call("lh_echo", { whileHeld: [{ sessionUpdate: "usage_update", used: 5, size: 10 }] }), say("ok")] });
	assert.equal((await usage.lesson([user("go")], [ECHO], async (c) => { await delay(150); return echoExec(c); })).last.stopReason, "stop");
	assert.equal(usage.prompts().length, 1, "a usage report while waiting is harmless");
});

test("after a clean tool turn the next turn reuses the parked session; a changed toolset gets a fresh one", async (t) => {
	const s = setup(t, { promptSeq: [[call("lh_echo"), say("first")], [say("second")], [say("third")]] });
	const one = await s.lesson([user("go")], [ECHO]);
	const two = await s.lesson([...one.messages, user("next")], [ECHO]);
	assert.equal(s.textOf(two.last), "second");
	const [p1, p2] = s.prompts();
	assert.equal(p2!.sessionId, p1!.sessionId, "reused");
	assert.deepEqual(p2!.texts, ["next"], "only the new message");
	const three = await s.lesson([...two.messages, user("more")], [ECHO, IMAGE]);
	assert.equal(s.textOf(three.last), "third");
	assert.notEqual(s.prompts()[2]!.sessionId, p1!.sessionId, "a different toolset means a fresh session");
	assert.equal(s.sent("session/new").length, 2);
});

test("kill switch off (LH_ANTIGRAVITY_TOOLS=0), or no chat key: no bridge, the text-only note, and any tool use is today's breach", async (t) => {
	for (const [what, prepare, sessionId] of [["switch off", () => { process.env.LH_ANTIGRAVITY_TOOLS = "0"; }, "chat-1"], ["no key", () => {}, undefined]] as const) {
		await t.test(what, async (tt) => {
			const s = setup(tt, { prompt: [{ permission: { title: "Run mcp_learnharness_lh_echo", kind: "other", name: "mcp_learnharness_lh_echo" } }, say("never")] });
			prepare();
			const reply = await s.once([user("go")], [ECHO], { sessionId });
			assert.equal(reply.stopReason, "error");
			assert.equal(reply.errorMessage, breachMessage("Run mcp_learnharness_lh_echo"));
			assert.deepEqual((s.sent("session/new")[0]!.params as { mcpServers: unknown[] }).mcpServers, []);
			assert.deepEqual(s.systemTexts(), [`${TEXT_ONLY_NOTE}\n\n${SYSTEM_TEXT}`]);
			assert.equal(toolBridgeOf(s.runtime.connection!), undefined, "no listener for text-only sessions");
		});
	}
});

const RED = Buffer.from("red pixels").toString("base64");
const BLUE = Buffer.from("blue pixels, a few more bytes").toString("base64");
const withImage = (text: string, data: string): Message => ({ role: "user", content: [{ type: "text", text }, { type: "image", data, mimeType: "image/png" }], timestamp: 0 });
type Logged = { sessionId: string; texts: (string | undefined)[]; blocks: { type: string; data?: string }[] };

test("images: a learner image goes out as an image block in order; over the cap or not advertised it is the placeholder", async (t) => {
	const { OMITTED_IMAGE, promptImageLimit } = await import("../src/agent/antigravity/transcript.ts");
	const saved = promptImageLimit.bytes;
	t.after(() => { promptImageLimit.bytes = saved; });
	const s = setup(t, { prompt: [say("A red square.")] });
	assert.deepEqual(toPiModel({ id: "m", name: "M" }).input, ["text", "image"], "the model takes images with the tools switch on");
	await s.once([withImage("What is this?", RED)], [ECHO]);
	const [first] = s.entries<Logged>("prompt");
	assert.deepEqual(first!.blocks, [{ type: "text" }, { type: "image", mimeType: "image/png", data: RED }]);
	assert.equal(first!.texts[0], "What is this?\n");
	await t.test("over the cap", async (tt) => {
		promptImageLimit.bytes = Buffer.byteLength(RED, "base64") + 1;
		const c = setup(tt, { prompt: [say("ok")] });
		await c.once([withImage("one", RED), { role: "assistant", content: [{ type: "text", text: "seen" }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 } as AssistantMessage, withImage("two", BLUE)], [ECHO], { sessionId: "chat-cap" });
		const [prompt] = c.entries<Logged>("prompt");
		assert.deepEqual(prompt!.blocks.map((b) => b.type), ["text", "image", "text"], "the first image fits, the second becomes the placeholder");
		assert.ok(prompt!.texts.at(-1)!.endsWith(`two\n${OMITTED_IMAGE}`));
		promptImageLimit.bytes = saved;
	});
	await t.test("not advertised", async (tt) => {
		const c = setup(tt, { noImagePrompts: true, prompt: [say("ok")] });
		await c.once([withImage("What is this?", RED)], [ECHO]);
		const [prompt] = c.entries<Logged>("prompt");
		assert.deepEqual(prompt!.blocks.map((b) => b.type), ["text"]);
		assert.equal(prompt!.texts[0], `What is this?\n${OMITTED_IMAGE}`);
	});
	await t.test("switch off", async (tt) => {
		const c = setup(tt, { prompt: [say("ok")] });
		process.env.LH_ANTIGRAVITY_TOOLS = "0";
		assert.deepEqual(toPiModel({ id: "m", name: "M" }).input, ["text"]);
		await c.once([withImage("What is this?", RED)], [ECHO]);
		assert.deepEqual(c.entries<Logged>("prompt")[0]!.blocks.map((b) => b.type), ["text"]);
	});
});

test("images: a reused session gets a new image as a block; a changed earlier image (same placeholder) means a fresh session", async (t) => {
	const s = setup(t, { prompt: [say("ok")] });
	const one = await s.lesson([user("hi")], [ECHO]);
	await s.lesson([...one.messages, withImage("look", RED)], [ECHO]);
	const [p1, p2] = s.entries<Logged>("prompt");
	assert.equal(p2!.sessionId, p1!.sessionId, "reused");
	assert.deepEqual(p2!.blocks, [{ type: "text" }, { type: "image", mimeType: "image/png", data: RED }]);
	const replyTwo = { role: "assistant", content: [{ type: "text", text: "ok" }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 } as AssistantMessage;
	await s.lesson([...one.messages, withImage("look", BLUE), replyTwo, user("and now?")], [ECHO]);
	assert.notEqual(s.entries<Logged>("prompt")[2]!.sessionId, p1!.sessionId, "the image bytes are part of what the session has seen");
});

test("usage: a tool-round message carries only the context size it saw; the final one adds up to the latest context size", async (t) => {
	const { measuredContextTokens } = await import("../src/core/context-usage.ts");
	// Figures from the lead's real probe (agy 1.5.15): usage_update before the call and after the reply.
	const usage = { inputTokens: 12497, outputTokens: 41, cachedReadTokens: 8296, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 20834 };
	const s = setup(t, { usage, prompt: [{ used: 10368 }, call("lh_echo"), say("ECHO:hello"), { used: 10466 }] });
	const { finals, messages } = await s.lesson([user("go")], [ECHO]);
	const buckets = (m: AssistantMessage) => [m.usage.input, m.usage.output, m.usage.cacheRead, m.usage.cacheWrite];
	assert.deepEqual(buckets(finals[0]!), [10368, 0, 0, 0]);
	assert.deepEqual(buckets(finals[1]!), [10466 - 41 - 8296, 41, 8296, 0]);
	assert.equal(finals[1]!.usage.totalTokens, 10466);
	const saved = messages.map((m, i) => ({ ...m, id: `m${i}` })) as unknown as Parameters<typeof measuredContextTokens>[0];
	assert.equal(measuredContextTokens(saved), 10466, "the context meter reads the context size, not a sum over rounds");
	assert.equal(measuredContextTokens(saved.slice(0, 2)), 10368, "and after the tool round alone, its own context size");
	await t.test("no tool round: the prompt's own counts, as before", async (tt) => {
		const plain = setup(tt, { usage, prompt: [{ used: 10368 }, say("hi")] });
		assert.deepEqual(buckets(await plain.once([user("hi")], [ECHO])), [12497, 41, 8296, 0]);
	});
	await t.test("clamped to the context size: the summed cache reads never inflate the total", async (tt) => {
		const small = setup(tt, { usage, prompt: [call("lh_echo"), say("x"), { used: 100 }] });
		const { last } = await small.lesson([user("go")], [ECHO]);
		assert.deepEqual(buckets(last), [0, 41, 59, 0]);
	});
	await t.test("the real four-round figures: the total is the latest used", async (tt) => {
		// Measured by the lead: a four-round prompt's result summed cache reads to 64,557 while the context was ~18.8k.
		const real = setup(tt, { usage: { inputTokens: 0, outputTokens: 632, cachedReadTokens: 64557, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 65189 }, prompt: [{ used: 17000 }, call("lh_echo"), { used: 18000 }, call("lh_echo"), { used: 18500 }, call("lh_echo"), { used: 18846 }, call("lh_echo"), say("done")] });
		const { finals, last } = await real.lesson([user("go")], [ECHO]);
		assert.deepEqual(finals.slice(0, 4).map((m) => m.usage.input), [17000, 18000, 18500, 18846]);
		assert.deepEqual(buckets(last), [0, 632, 18846 - 632, 0]);
		assert.equal(buckets(last).reduce((a, b) => a + b, 0), 18846);
	});
	await t.test("no usage_update ever: the result's own numbers, as for a prompt with no tool round", async (tt) => {
		const none = setup(tt, { usage, prompt: [call("lh_echo"), say("x")] });
		const { last } = await none.lesson([user("go")], [ECHO]);
		assert.deepEqual(buckets(last), [12497, 41, 8296, 0]);
	});
});

test("reuse off (LH_ANTIGRAVITY_REUSE=0): a tool round still resumes the same prompt; the session is then closed, not parked", async (t) => {
	const s = setup(t, { prompt: [call("lh_echo", { echo: true }), say(" done")] });
	process.env.LH_ANTIGRAVITY_REUSE = "0";
	const { finals, last } = await s.lesson([user("go")], [ECHO]);
	assert.deepEqual(finals.map((m) => m.stopReason), ["toolUse", "stop"]);
	assert.equal(s.textOf(last), "tool said: ECHO:hello done");
	assert.equal(s.prompts().length, 1);
	await waitFor(() => s.sent("session/close").length === 1, 3000, "the session to close");
	assert.equal(parkedSessionCount(s.runtime.connection!), 0);
});

test("Stop while the SECOND round's call waits expires it too", async (t) => {
	const s = setup(t, { prompt: [call("lh_echo"), call("lh_echo"), say("never")] });
	const controller = new AbortController();
	const first = await s.once([user("go")], [ECHO], { signal: controller.signal });
	const firstCall = first.content.find((b) => b.type === "toolCall") as ToolCall;
	const history: Message[] = [user("go"), first, { role: "toolResult", toolCallId: firstCall.id, toolName: "lh_echo", content: [{ type: "text", text: "one" }], isError: false, timestamp: 0 }];
	const second = await s.once(history, [ECHO], { signal: controller.signal });
	assert.equal(second.stopReason, "toolUse", "the second round");
	assert.equal(waitingTurnCount(s.runtime.connection!), 1);
	controller.abort(); // the learner presses Stop while pi runs the second call
	await waitFor(() => s.sent("session/cancel").length === 1, 3000, "the cancel");
	await waitFor(() => s.sent("session/close").length === 1, 3000, "the close");
	assert.equal(waitingTurnCount(s.runtime.connection!), 0);
});

test("turning the provider off expires a waiting call at once instead of holding agy for the wait", async (t) => {
	const s = setup(t, { prompt: [call("lh_echo"), say("never")] });
	assert.equal((await s.once([user("go")], [ECHO])).stopReason, "toolUse");
	assert.equal(waitingTurnCount(s.runtime.connection!), 1);
	expireWaitingTurns(s.runtime);
	await waitFor(() => s.sent("session/close").length === 1, 3000, "the close");
	assert.equal(s.sent("session/cancel").length, 1);
	assert.equal(waitingTurnCount(s.runtime.connection!), 0);
});

test("fail closed: an MCP call on a parked session poisons it; a permission while waiting, a second permission before the call, or another call id with our name while waiting all end the round", async (t) => {
	await t.test("MCP call on a parked session", async (tt) => {
		const s = setup(tt, { parkedUpdate: "mcp", prompt: [say("first")] });
		await s.once([user("go")], [ECHO]);
		await waitFor(() => s.entries<{ parked?: boolean }>("mcp-result").some((e) => e.parked), 3000, "the parked call");
		const parked = s.entries<{ parked?: boolean; result: { isError?: boolean; error?: string } }>("mcp-result").find((e) => e.parked)!;
		assert.ok(parked.result.isError || parked.result.error, "refused");
		await waitFor(() => s.sent("session/close").length === 1, 3000, "the poisoned session to close");
		assert.equal(parkedSessionCount(s.runtime.connection!), 0);
	});
	await t.test("permission while waiting", async (tt) => {
		const s = setup(tt, { promptSeq: [[call("lh_echo", { whileHeldPermission: true }), say("never")]], prompt: [say("Fresh")] });
		const { last } = await s.lesson([user("go")], [ECHO], async (c) => { await waitFor(() => s.sent("session/cancel").length === 1, 3000, "expiry"); return echoExec(c); });
		assert.equal(s.textOf(last), "Fresh");
		const again = s.entries<{ whileHeld?: boolean; answer: unknown }>("permission-answer").find((e) => e.whileHeld);
		assert.deepEqual(again?.answer, { outcome: { outcome: "selected", optionId: "deny" } });
	});
	await t.test("second permission before the allowed call", async (tt) => {
		const s = setup(tt, { prompt: [call("lh_echo", { noCall: true }), call("lh_echo"), say("never")] });
		const { last } = await s.lesson([user("go")], [ECHO]);
		assert.equal(last.stopReason, "error");
		assert.match(last.errorMessage ?? "", /^Antigravity tried to use a tool LearnHarness didn't give it/);
		await waitFor(() => s.entries("permission-answer").length === 2, 3000, "both answers");
		assert.deepEqual(s.entries<{ answer: { outcome: { optionId: string } } }>("permission-answer").map((e) => e.answer.outcome.optionId), ["allow", "deny"]);
	});
	await t.test("our tool name with another call id while waiting", async (tt) => {
		const s = setup(tt, { promptSeq: [[call("lh_echo", { whileHeld: [{ sessionUpdate: "tool_call_update", toolCallId: "call_other", name: "mcp_{server}_lh_echo", status: "in_progress" }] }), say("never")]], prompt: [say("Fresh")] });
		const { last } = await s.lesson([user("go")], [ECHO], async (c) => { await waitFor(() => s.sent("session/cancel").length === 1, 3000, "expiry"); return echoExec(c); });
		assert.equal(s.textOf(last), "Fresh");
	});
});

test("every tool session gets its own MCP server name (lh + 10 hex, never reused in the process), so the agent never suffixes our tools", async (t) => {
	const s = setup(t, { prompt: [call("lh_echo"), say("ok")] });
	for (const chat of ["chat-a", "chat-b", "chat-c"]) {
		const { last } = await s.lesson([user(`go ${chat}`)], [ECHO], echoExec, { sessionId: chat });
		assert.equal(last.stopReason, "stop", `${chat}: ${last.errorMessage ?? ""}`);
	}
	const names = s.sent("session/new").map((m) => (m.params as { mcpServers: { name: string }[] }).mcpServers[0]!.name);
	assert.equal(names.length, 3);
	for (const name of names) assert.match(name, /^lh[0-9a-f]{10}$/);
	assert.equal(new Set(names).size, 3, "no server name is sent twice in one process");
	const listed = s.entries<{ server: string; agentNames: string[] }>("mcp-tools");
	assert.deepEqual(listed.map((e) => e.agentNames), names.map((name) => [`mcp_${name}_lh_echo`]), "the agent added no suffix");
	assert.deepEqual(new Set(s.systemTexts()).size, 1, "the system note names no server, so it is the same for every session");
	assert.ok(!s.systemTexts()[0]!.includes("mcp_lh"));
});

test("only mcp_<this session's server>_<declared tool> is ours: a foreign or suffixed server segment is refused", async (t) => {
	for (const [what, agentName, shown] of [
		["foreign server", "mcp_learnharness_lh_echo", "Run mcp_learnharness_lh_echo"],
		["agent-suffixed", "mcp_{server}_94df266b_lh_echo", "94df266b_lh_echo"],
		["other session's shape", "mcp_lh0000000000_lh_echo", "Run mcp_lh0000000000_lh_echo"],
	] as const) {
		await t.test(what, async (tt) => {
			const s = setup(tt, { prompt: [call("lh_echo", { agentName }), say("never")] });
			const { last } = await s.lesson([user("go")], [ECHO]);
			assert.equal(last.stopReason, "error");
			assert.equal(last.errorMessage, toolBreachMessage(shown));
			assert.equal(s.entries("mcp-result").length, 0);
		});
	}
});

// ── review fixes (independent review of the tools code) ─────────────────────

test("no lost answer: the agent's held request is gone just before the result arrives → the answer reaches the model once, through the replay", async (t) => {
	const { toolBridgeTestHooks } = await import("../src/agent/antigravity/tool-bridge.ts");
	let held: { destroy(): void } | undefined;
	toolBridgeTestHooks.onHeld = (_call, res) => { held = res; };
	t.after(() => { delete toolBridgeTestHooks.onHeld; });
	const s = setup(t, { promptSeq: [[call("lh_echo"), say("never")]], prompt: [say("Fresh")] });
	const { finals, last } = await s.lesson([user("go")], [ECHO], async (c) => { const result = await echoExec(c); held!.destroy(); return result; });
	assert.deepEqual(finals.map((m) => m.stopReason), ["toolUse", "stop"]);
	assert.equal(s.textOf(last), "Fresh", "never an error while the answer is in hand");
	const replay = s.prompts().at(-1)!.texts.join("\n");
	assert.equal(replay.split("[tool result lh_echo]\nECHO:hello").length - 1, 1, "exactly once");
});

test("no lost answer: a request already dead before the handler runs is never handed to pi", async (t) => {
	const { toolBridgeTestHooks } = await import("../src/agent/antigravity/tool-bridge.ts");
	toolBridgeTestHooks.beforeDispatch = (res) => { res.destroy(); };
	t.after(() => { delete toolBridgeTestHooks.beforeDispatch; });
	const s = setup(t, { prompt: [call("lh_echo"), say("carried on")] });
	const { finals } = await s.lesson([user("go")], [ECHO]);
	assert.deepEqual(finals.map((m) => m.stopReason), ["stop"], "no tool call for a dead request");
	assert.equal(s.textOf(finals[0]!), "carried on");
});

test("an allowed call that never reached the bridge: 'completed' is a breach, 'failed' only ends the allowance", async (t) => {
	await t.test("completed", async (tt) => {
		const s = setup(tt, { prompt: [call("lh_echo", { noCall: true, endStatus: "completed" }), say("never")] });
		const { last } = await s.lesson([user("go")], [ECHO]);
		assert.equal(last.stopReason, "error");
		assert.equal(last.errorMessage, toolBreachMessage("lh_echo"));
	});
	await t.test("failed", async (tt) => {
		const s = setup(tt, { prompt: [call("lh_echo", { noCall: true, endStatus: "failed" }), call("lh_echo"), say("fine")] });
		const { last } = await s.lesson([user("go")], [ECHO]);
		assert.equal(last.stopReason, "stop", last.errorMessage);
	});
});

test("a tool call after the provider was turned off mid-reply: pi gets the call, the wait expires at once", async (t) => {
	const { h, runtime } = base(t, { prompt: [say("thinking "), { sleepMs: 300 }, call("lh_echo"), say("never")] });
	let available = true;
	const stream = createAntigravityStreamFunction({ runtime: () => runtime, host: () => ({ available: () => available, models: () => [], saveModels: () => {} }) });
	const events = stream(PRO, normalizeContext({ systemPrompt: SYSTEM_TEXT, messages: [user("go")], tools: [ECHO] }), { sessionId: "chat-off" });
	await waitFor(() => h.log().some((e) => e.kind === "prompt"), 3000, "the prompt");
	available = false;
	for await (const _event of events) { /* drain */ }
	assert.equal((await events.result()).stopReason, "toolUse");
	await waitFor(() => h.received().some((m) => m.method === "session/close"), 3000, "the close");
	assert.ok(h.received().some((m) => m.method === "session/cancel"));
	assert.equal(waitingTurnCount(runtime.connection!), 0);
});

test("fail closed: malformed mode or config updates while streaming or during setup stop the turn", async (t) => {
	for (const [what, scenario] of [
		["config while streaming", { prompt: [say("a"), { update: { sessionUpdate: "config_option_update", configOptions: "nope" } }, say("never")] }],
		["mode while streaming", { prompt: [say("a"), { update: { sessionUpdate: "current_mode_update", currentModeId: 5 } }, say("never")] }],
		["config during setup", { updateAfterNew: { sessionUpdate: "config_option_update", configOptions: { not: "a list" } }, prompt: [say("never")] }],
		["mode during setup", { updateAfterNew: { sessionUpdate: "current_mode_update", currentModeId: null }, prompt: [say("never")] }],
	] as const) {
		await t.test(what, async (tt) => {
			const s = setup(tt, scenario as MockScenario);
			const reply = await s.once([user("go")], [ECHO]);
			assert.equal(reply.stopReason, "error", what);
			assert.ok(!s.textOf(reply).includes("never"));
		});
	}
});

test("fail closed while waiting: a model switch, another tool name on the held id, an unknown update kind expire; harmless kinds don't", async (t) => {
	for (const [what, extra] of [
		["model switch", { whileHeldModel: "gemini-3-flash" }],
		["other tool name, same id", { whileHeld: [{ sessionUpdate: "tool_call_update", toolCallId: "{id}", name: "mcp_{server}_lh_image", status: "in_progress" }] }],
		["unknown kind", { whileHeld: [{ sessionUpdate: "plan", entries: [] }] }],
	] as const) {
		await t.test(what, async (tt) => {
			const s = setup(tt, { promptSeq: [[call("lh_echo", extra), say("never")]], prompt: [say("Fresh")] });
			const { last } = await s.lesson([user("go")], [ECHO, IMAGE], async (c) => { await waitFor(() => s.sent("session/cancel").length === 1, 3000, "expiry"); return echoExec(c); });
			assert.equal(s.textOf(last), "Fresh");
		});
	}
	const ok = setup(t, { prompt: [call("lh_echo", { whileHeld: [{ sessionUpdate: "session_info_update", title: "x" }, { sessionUpdate: "available_commands_update", availableCommands: [] }, { sessionUpdate: "tool_call_update", toolCallId: "{id}", name: "mcp_{server}_lh_echo", status: "in_progress" }] }), say("ok")] });
	const { last } = await ok.lesson([user("go")], [ECHO], async (c) => { await delay(150); return echoExec(c); });
	assert.equal(last.stopReason, "stop");
	assert.equal(ok.prompts().length, 1, "harmless updates while waiting keep the round");
});

test("fail closed: a permission or tool update without a proper toolCallId is a breach", async (t) => {
	for (const [what, toolCallId] of [["missing", null], ["empty", ""]] as const) {
		await t.test(what, async (tt) => {
			const s = setup(tt, { prompt: [call("lh_echo", { toolCallId }), say("never")] });
			const { last } = await s.lesson([user("go")], [ECHO]);
			assert.equal(last.stopReason, "error", what);
			assert.match(last.errorMessage ?? "", /^Antigravity tried to use a tool/);
		});
	}
});

test("a closed session's endpoint closes at once, not after session/close answers", async (t) => {
	const s = setup(t, { hangMethods: ["session/close"], prompt: [call("lh_echo"), say("ok")] });
	process.env.LH_ANTIGRAVITY_REUSE = "0";
	await s.lesson([user("go")], [ECHO]);
	await waitFor(() => s.sent("session/close").length === 1, 3000, "session/close sent");
	assert.equal(toolBridgeOf(s.runtime.connection!)!.size, 0);
});

test("a resumed stream leaves no abort listener behind on any earlier stream's signal", async (t) => {
	const s = setup(t, { prompt: [call("lh_echo"), call("lh_echo"), call("lh_echo"), say("done")] });
	const controller = new AbortController();
	const { last } = await s.lesson([user("go")], [ECHO], echoExec, { signal: controller.signal });
	assert.equal(last.stopReason, "stop");
	await delay(50);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
