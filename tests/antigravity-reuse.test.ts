/**
 * One agent session per lesson (session reuse, docs/antigravity.md): a turn
 * continues its chat's parked agent session, sending only the new messages,
 * when LearnHarness can prove the agent has seen exactly the rest; anything
 * else falls back to a fresh session. Every assertion reads the mock's log:
 * which agent session got what text.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AssistantMessage, Message, ThinkingLevel } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { AntigravityMessage, TEXT_ONLY_NOTE } from "../src/agent/antigravity/constants.ts";
import { toPiModel } from "../src/agent/antigravity/models.ts";
import { AntigravityRuntime, antigravityTimeouts } from "../src/agent/antigravity/runtime.ts";
import { antigravityLimits, createAntigravityStreamFunction, MAX_PARKED_SESSIONS, parkedSessionCount } from "../src/agent/antigravity/stream.ts";
import { mockHarness, waitFor, type MockHarness, type MockScenario } from "./helpers/antigravity-mock.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

const DEFAULTS = { ...antigravityTimeouts };
const PRO = toPiModel({ id: "gemini-3-pro", name: "Gemini 3 Pro", levels: ["low", "medium", "high", "xhigh"] });
const FLASH = toPiModel({ id: "gemini-3-flash", name: "Gemini 3 Flash", levels: ["low", "medium", "high"] });
const SYSTEM = (text = "You are a patient tutor.") => ({ role: "system", content: text, timestamp: 0 }) as Message;
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

type Prompt = { sessionId: string; n: number; texts: string[] };

function setup(t: TestContext, scenario: MockScenario = {}) {
	const previous = process.env.LH_ANTIGRAVITY_REUSE;
	if (previous === "0") delete process.env.LH_ANTIGRAVITY_REUSE; // these tests are about reuse ON unless they say otherwise
	t.after(() => { if (previous === undefined) delete process.env.LH_ANTIGRAVITY_REUSE; else process.env.LH_ANTIGRAVITY_REUSE = previous; });
	const h = mockHarness(t, { sessionClose: true, ...scenario });
	const tempBase = mkdtempSync(join(tmpdir(), "lh-agy-reuse-"));
	const runtime = new AntigravityRuntime({ launch: h.launch, tempBase });
	const stream = createAntigravityStreamFunction({ runtime: () => runtime, host: () => ({ available: () => true, models: () => [], saveModels: () => {} }) });
	h.onTeardown(() => runtime.shutdown());
	t.after(() => { Object.assign(antigravityTimeouts, DEFAULTS); rmSync(tempBase, { recursive: true, force: true }); });
	/** One turn; returns the final message, as LearnHarness would save it. */
	const turn = async (messages: Message[], options: { sessionId?: string; reasoning?: ThinkingLevel; model?: typeof PRO; signal?: AbortSignal } = {}): Promise<AssistantMessage> => {
		const events = stream(options.model ?? PRO, normalizeContext({ messages }), { ...(options.sessionId ? { sessionId: options.sessionId } : {}), ...(options.reasoning ? { reasoning: options.reasoning } : {}), ...(options.signal ? { signal: options.signal } : {}) });
		for await (const _event of events) { /* drain */ }
		return events.result();
	};
	const prompts = (): Prompt[] => h.log().filter((entry) => entry.kind === "prompt") as unknown as Prompt[];
	const count = (method: string) => h.methods().filter((m) => m === method).length;
	const closed = () => h.received().filter((m) => m.method === "session/close").map((m) => (m.params as { sessionId: string }).sessionId);
	return { h, runtime, turn, prompts, count, closed };
}

/** A lesson: system + alternating turns, the assistant messages as the turns produced them. */
async function lesson(turn: ReturnType<typeof setup>["turn"], texts: string[], sessionId = "chat-1") {
	const history: Message[] = [SYSTEM()];
	const replies: AssistantMessage[] = [];
	for (const text of texts) {
		history.push(user(text));
		const reply = await turn([...history], { sessionId });
		replies.push(reply);
		history.push(reply);
	}
	return { history, replies };
}

test("1. strict append: three turns on one agent session, only the new message sent, no system text resent", async (t) => {
	const s = setup(t, { systemPromptAppend: false });
	const { replies } = await lesson(s.turn, ["first question", "second question", "third question"]);
	assert(replies.every((reply) => reply.stopReason === "stop"));
	assert.equal(s.count("session/new"), 1);
	const prompts = s.prompts();
	assert.deepEqual(prompts.map((p) => p.n), [1, 2, 3]);
	assert.equal(new Set(prompts.map((p) => p.sessionId)).size, 1, "one agent session");
	assert.match(prompts[0]!.texts[0]!, new RegExp(TEXT_ONLY_NOTE.slice(0, 30)), "the fresh session got the system text");
	assert.deepEqual(prompts[1]!.texts, ["second question"]);
	assert.deepEqual(prompts[2]!.texts, ["third question"]);
	assert.equal(replies[1]!.usage.cacheRead, 10900, "the reused turn reports the cache read");
	assert.equal(s.closed().length, 0, "parked, not closed");
	assert.equal(parkedSessionCount(s.runtime.connection!), 1);
});

test("2. no reuse, a fresh session and the old one closed: edit, removal, system text, model, assistant in the tail, no sessionId, switch off", async (t) => {
	const cases: { name: string; next: (h: { history: Message[]; replies: AssistantMessage[] }) => { messages: Message[]; model?: typeof PRO; sessionId?: string } }[] = [
		{ name: "an earlier message edited", next: ({ history }) => ({ messages: [SYSTEM(), user("first question, edited"), history[2]!, user("next")] }) },
		{ name: "a message removed", next: () => ({ messages: [SYSTEM(), user("first question"), user("next")] }) },
		{ name: "system text changed", next: ({ history }) => ({ messages: [SYSTEM("You are a strict examiner."), history[1]!, history[2]!, user("next")] }) },
		{ name: "model changed", next: ({ history }) => ({ messages: [...history, user("next")], model: FLASH }) },
		{ name: "an assistant message in the tail", next: ({ history }) => ({ messages: [...history, user("next"), { ...(history[2] as AssistantMessage), content: [{ type: "text", text: "not the agent's" }] }, user("again")] }) },
	];
	for (const c of cases) {
		const s = setup(t);
		const first = await lesson(s.turn, ["first question"]);
		const firstSession = s.prompts()[0]!.sessionId;
		const next = c.next(first);
		const reply = await s.turn(next.messages, { sessionId: "chat-1", ...(next.model ? { model: next.model } : {}) });
		assert.equal(reply.stopReason, "stop", `${c.name}: ${reply.errorMessage}`);
		assert.equal(s.count("session/new"), 2, c.name);
		const prompts = s.prompts();
		assert.notEqual(prompts[1]!.sessionId, firstSession, c.name);
		assert.equal(prompts[1]!.n, 1, `${c.name}: a fresh session with the full replay`);
		await waitFor(() => s.closed().includes(firstSession), 3000, `${c.name}: the old session closed`);
	}

	const noKey = setup(t);
	await noKey.turn([SYSTEM(), user("q")]);
	await waitFor(() => noKey.closed().length === 1, 3000, "no sessionId: never parked, closed");
	assert.equal(parkedSessionCount(noKey.runtime.connection!), 0);

	const off = setup(t);
	process.env.LH_ANTIGRAVITY_REUSE = "0";
	await lesson(off.turn, ["first question", "second question"]);
	assert.equal(off.count("session/new"), 2, "switch off: a fresh session every turn");
	assert.equal(off.prompts()[1]!.n, 1);
	await waitFor(() => off.closed().length === 2, 3000, "switch off: every session closed");
});

test("3. never parked after an error, abort, breach, \"length\", refusal, mode change or a reply too long", async (t) => {
	const cases: { name: string; scenario: MockScenario; abort?: boolean; tooLong?: boolean }[] = [
		{ name: "error", scenario: { prompt: [{ error: { code: -32099, message: "boom" } }] } },
		{ name: "abort", scenario: { prompt: [{ text: "partial" }, { waitForCancel: true }] }, abort: true },
		{ name: "breach", scenario: { prompt: [{ toolCall: { toolCallId: "c1", title: "Run ls", kind: "execute" } }, { waitForCancel: true }] } },
		{ name: "length", scenario: { stopReason: "max_tokens" } },
		{ name: "refusal", scenario: { stopReason: "refusal" } },
		{ name: "mode changed", scenario: { prompt: [{ text: "a" }, { modeUpdate: "auto" }, { waitForCancel: true }] } },
		{ name: "too long", scenario: { prompt: [{ text: "x".repeat(64) }, { waitForCancel: true }] }, tooLong: true },
	];
	for (const c of cases) {
		const s = setup(t, c.scenario);
		if (c.tooLong) { antigravityLimits.replyBytes = 16; t.after(() => { antigravityLimits.replyBytes = 4 * 1024 * 1024; }); }
		const controller = new AbortController();
		const running = s.turn([SYSTEM(), user("q")], { sessionId: "chat-1", signal: controller.signal });
		if (c.abort) { await waitFor(() => s.prompts().length === 1, 3000, "prompt open"); controller.abort(); }
		const reply = await running;
		assert.notEqual(reply.stopReason, "stop", c.name);
		if (c.tooLong) antigravityLimits.replyBytes = 4 * 1024 * 1024;
		const firstSession = s.prompts()[0]!.sessionId;
		await waitFor(() => s.closed().includes(firstSession) || !s.runtime.connection, 3000, `${c.name}: closed`);
		if (s.runtime.connection) assert.equal(parkedSessionCount(s.runtime.connection), 0, c.name);
	}
});

test("4. a tool call or permission request to a parked session closes it; the next turn is fresh", async (t) => {
	for (const parkedUpdate of ["tool", "permission"]) {
		const s = setup(t, { parkedUpdate });
		const first = await lesson(s.turn, ["first question"]);
		const firstSession = s.prompts()[0]!.sessionId;
		await waitFor(() => s.closed().includes(firstSession), 3000, `${parkedUpdate}: parked session closed`);
		if (parkedUpdate === "permission") {
			await waitFor(() => s.h.log().some((e) => e.kind === "permission-answer"), 3000, "answered");
			assert.deepEqual(s.h.log().find((e) => e.kind === "permission-answer")!.answer, { outcome: { outcome: "selected", optionId: "stop-this-command" } });
		}
		assert.equal(parkedSessionCount(s.runtime.connection!), 0);
		const reply = await s.turn([...first.history, user("next")], { sessionId: "chat-1" });
		assert.equal(reply.stopReason, "stop");
		assert.equal(s.count("session/new"), 2, `${parkedUpdate}: fresh`);
		assert.notEqual(s.prompts()[1]!.sessionId, firstSession);
	}
});

test("5. mode flipped to \"auto\" while parked: the next turn sets \"default\" and confirms first, or fails closed", async (t) => {
	const s = setup(t, { parkedUpdate: "mode" });
	const first = await lesson(s.turn, ["first question"]);
	const firstSession = s.prompts()[0]!.sessionId;
	await new Promise((resolve) => setTimeout(resolve, 150)); // the flip arrives while parked
	const reply = await s.turn([...first.history, user("next")], { sessionId: "chat-1" });
	assert.equal(reply.stopReason, "stop", reply.errorMessage);
	assert.equal(s.count("session/new"), 1, "reused");
	const received = s.h.received();
	const modeAt = received.findIndex((m) => m.method === "session/set_config_option" && (m.params as { configId: string; sessionId: string }).configId === "mode" && (m.params as { sessionId: string }).sessionId === firstSession);
	const promptAt = received.flatMap((m, i) => (m.method === "session/prompt" ? [i] : []));
	assert.ok(modeAt > promptAt[0]! && modeAt < promptAt[1]!, "mode set to default on the reused session, before its prompt");
	assert.equal(s.prompts()[1]!.sessionId, firstSession);

	const refused = setup(t, { parkedUpdate: "mode", rejectModeChange: true });
	const lessonB = await lesson(refused.turn, ["first question"]);
	const sessionB = refused.prompts()[0]!.sessionId;
	await new Promise((resolve) => setTimeout(resolve, 150));
	const failed = await refused.turn([...lessonB.history, user("next")], { sessionId: "chat-1" });
	assert.equal(failed.errorMessage, AntigravityMessage.ModeNotSet);
	assert.equal(refused.prompts().length, 1, "no prompt on the unconfirmed session");
	await waitFor(() => refused.closed().includes(sessionB), 3000, "and that session is closed");
});

test("6. a thinking level changed between turns is set on the reused session before its prompt", async (t) => {
	const s = setup(t);
	const history: Message[] = [SYSTEM(), user("first question")];
	history.push(await s.turn([...history], { sessionId: "chat-1", reasoning: "high" }));
	history.push(user("now think less"));
	const reply = await s.turn([...history], { sessionId: "chat-1", reasoning: "low" });
	assert.equal(reply.stopReason, "stop", reply.errorMessage);
	assert.equal(s.count("session/new"), 1);
	const sets = s.h.received().filter((m) => m.method === "session/set_config_option").map((m) => [(m.params as { configId: string }).configId, (m.params as { value: string }).value]);
	assert.deepEqual(sets, [["thought_level", "low"]]);
	assert.deepEqual(s.prompts()[1]!.texts, ["now think less"]);
});

test("7. least-recently-used eviction beyond 8 chats; process death drops every parked session", async (t) => {
	const s = setup(t);
	for (let chat = 1; chat <= MAX_PARKED_SESSIONS + 1; chat++) await s.turn([SYSTEM(), user(`chat ${chat}`)], { sessionId: `chat-${chat}` });
	const connection = s.runtime.connection!;
	assert.equal(parkedSessionCount(connection), MAX_PARKED_SESSIONS);
	const chat1Session = s.prompts()[0]!.sessionId;
	await waitFor(() => s.closed().includes(chat1Session), 3000, "chat 1's session evicted and closed");
	await s.turn([SYSTEM(), user("chat 1")], { sessionId: "chat-1" });
	assert.equal(s.count("session/new"), MAX_PARKED_SESSIONS + 2, "chat 1 starts fresh");

	s.h.children[0]!.kill("SIGKILL");
	await connection.closed;
	assert.equal(parkedSessionCount(connection), 0);
	const after = await s.turn([SYSTEM(), user("chat 2"), { role: "assistant", content: [{ type: "text", text: "Hello world" }], api: "antigravity-acp", provider: "antigravity", model: "gemini-3-pro", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 } as Message, user("more")], { sessionId: "chat-2" });
	assert.equal(after.stopReason, "stop");
	assert.equal(s.h.spawns, 2);
	assert.equal(s.prompts().at(-1)!.n, 1, "a fresh session on the new process");
});

test("8. two concurrent turns for one chat never share a session; the last clean finisher is parked", async (t) => {
	const s = setup(t, { prompt: [{ echo: true }, { sleepMs: 150 }] });
	const first = await lesson(s.turn, ["first question"]);
	const [a, b] = await Promise.all([
		s.turn([...first.history, user("A")], { sessionId: "chat-1" }),
		s.turn([...first.history, user("B")], { sessionId: "chat-1" }),
	]);
	assert.equal(a.stopReason, "stop");
	assert.equal(b.stopReason, "stop");
	const [, one, two] = s.prompts();
	assert.notEqual(one!.sessionId, two!.sessionId, "never the same agent session");
	assert.deepEqual([one!.n, two!.n].sort(), [1, 2], "one reused the parked session, the other started fresh");
	assert.equal(parkedSessionCount(s.runtime.connection!), 1);
	assert.equal(s.count("session/new"), 2);
});
