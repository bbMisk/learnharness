/**
 * LearnHarness tools on an Antigravity lesson, end to end through handleChatInput with production's
 * own agent builder (prober, then teacher) and their real tools (docs/antigravity.md). The mock agent calls the lesson's tools
 * through the loopback MCP bridge like agy 1.5.15 (tests/fixtures/antigravity/mock-agy.mjs).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { LaunchAgent } from "../src/agent/antigravity/binary.ts";
import { MOCK_AGY, mockHarness, waitFor, type MockHarness } from "./helpers/antigravity-mock.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

// Isolation first: no ambient keys, data, network (the bridge is loopback, so fetch to 127.0.0.1 stays open).
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-lesson-tools-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json") };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.hostname !== "127.0.0.1") throw new Error("CLOSED: unexpected network request");
	return originalFetch(input, init);
};

const { AntigravityRuntime, antigravityTimeouts } = await import("../src/agent/antigravity/runtime.ts");
const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-lesson-tools-run-"));
let launchReal: LaunchAgent | undefined;
const runtime = new AntigravityRuntime({ launch: (args, options) => (launchReal ? launchReal(args, options) : null), tempBase });
(globalThis as Record<symbol, unknown>)[Symbol.for("lh.antigravity.runtime")] = runtime;

const { antigravityStore } = await import("../src/store/antigravity.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { waitingTurnCount } = await import("../src/agent/antigravity/stream.ts");

const DEFAULTS = { ...antigravityTimeouts };
after(() => {
	runtime.shutdown();
	Object.assign(antigravityTimeouts, DEFAULTS);
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	fs.rmSync(directory, { recursive: true, force: true });
	fs.rmSync(tempBase, { recursive: true, force: true });
});

process.env.LH_FORK_ANTIGRAVITY = "1";
process.env.LH_AGY_BINARY = MOCK_AGY;
antigravityStore.update({ enabled: true, models: [{ id: "gemini-3-pro", name: "Gemini 3 Pro", levels: [] }] });

const ASK = { question: "Which topic should we cover next?", options: [{ label: "Chemistry" }, { label: "History" }] };

function lessonChat(title: string) {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, { model: { provider: "antigravity", id: "gemini-3-pro" } });
	return chat;
}

async function settle(chatId: string, response: Response): Promise<void> {
	assert.equal(response.status, 200, await response.clone().text());
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
	await waitFor(() => !runningTurn(chatId), 10_000, "turn settled");
}

type Saved = { role?: string; content?: unknown; toolCallId?: string; stopReason?: string };
const messagesOf = (chatId: string) => chatStore.getChat(chatId)!.messages as Saved[];
const lastReply = (chatId: string) => {
	const reply = messagesOf(chatId).findLast((m) => m.role === "assistant") as { content: { type: string; text?: string }[]; stopReason?: string } | undefined;
	return { text: reply?.content.filter((b) => b.type === "text").map((b) => b.text).join("") ?? "", stopReason: reply?.stopReason };
};
const pendingCall = (chatId: string) => {
	const assistant = messagesOf(chatId).findLast((m) => m.role === "assistant") as { content: { type: string; id?: string; name?: string }[] };
	return assistant.content.find((b) => b.type === "toolCall")!;
};
const askAnswer = () => ({ kind: "ask", questionText: ASK.question, dontKnow: false, answers: [], text: "History", answeredAt: new Date().toISOString() });

function harness(t: Parameters<typeof mockHarness>[0], scenario: Record<string, unknown>): MockHarness {
	const h = mockHarness(t, { sessionClose: true, ...scenario });
	h.onTeardown(() => runtime.shutdown());
	launchReal = h.launch;
	return h;
}

test("the tutor asks with the real question tool; the learner answers within the deadline and the SAME agent prompt continues", async (t) => {
	const h = harness(t, { prompt: [{ text: "Let me ask. " }, { mcpCall: { name: "ask_user_question", arguments: ASK, echo: true } }, { text: " Great, History it is." }] });
	const chat = lessonChat("Antigravity question resume");
	await settle(chat.id, await handleChatInput(chat.id, { type: "text", text: "Teach me something" }));
	const call = pendingCall(chat.id);
	assert.equal(call.name, "ask_user_question", "the question is pending in the lesson");
	assert.equal(waitingTurnCount(runtime.connection!), 1, "the agent's prompt waits for the answer");
	await settle(chat.id, await handleChatInput(chat.id, { type: "answer", toolCallId: call.id!, answer: askAnswer() }));
	const reply = lastReply(chat.id);
	assert.equal(reply.stopReason, "stop");
	assert.match(reply.text, /^tool said: .*History[\s\S]* Great, History it is\.$/);
	assert.equal(h.methods().filter((m) => m === "session/prompt").length, 1, "one agent prompt across the question");
	assert.equal(h.methods().filter((m) => m === "session/new").length, 1);
	const mcpTools = h.log().find((e) => e.kind === "mcp-tools") as unknown as { names: string[] };
	assert.ok(mcpTools.names.includes("ask_user_question"), "the lesson's declared tools were listed");
	assert.ok(!mcpTools.names.some((name) => /^(bash|run_command|write)$/.test(name)));
	runtime.shutdown();
	await h.assertNoChildren();
});

test("the learner answers after the deadline: the waiting prompt expired, the answer gets a fresh session with the labelled call and result", async (t) => {
	antigravityTimeouts.toolWaitMs = 200;
	t.after(() => { antigravityTimeouts.toolWaitMs = DEFAULTS.toolWaitMs; });
	const h = harness(t, { promptSeq: [[{ mcpCall: { name: "ask_user_question", arguments: ASK } }, { text: "never" }], [{ text: "Welcome back: History." }]] });
	const chat = lessonChat("Antigravity question replay");
	await settle(chat.id, await handleChatInput(chat.id, { type: "text", text: "Teach me something" }));
	await waitFor(() => h.methods().includes("session/cancel"), 5000, "expiry");
	await waitFor(() => waitingTurnCount(runtime.connection!) === 0, 5000, "no waiting prompt");
	const call = pendingCall(chat.id);
	await settle(chat.id, await handleChatInput(chat.id, { type: "answer", toolCallId: call.id!, answer: askAnswer() }));
	assert.equal(lastReply(chat.id).text, "Welcome back: History.");
	const prompts = h.received().filter((m) => m.method === "session/prompt");
	assert.equal(prompts.length, 2);
	const replay = JSON.stringify(prompts[1]);
	assert.match(replay, /\[tool call ask_user_question\]/);
	assert.match(replay, /\[tool result ask_user_question\][\s\S]*History/);
	runtime.shutdown();
	await h.assertNoChildren();
});

test("one PDF tool round: the tutor calls pdf on a fixture PDF, LearnHarness runs the tool (a job for that file), and the lesson goes on", async (t) => {
	fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf"), path.join(directory, "lesson.pdf"));
	const pdfPath = path.join(directory, "lesson.pdf");
	// Later prompts (the job's own follow-up) only talk: a tutor that re-called pdf on every result would loop.
	const h = harness(t, { promptSeq: [[{ mcpCall: { name: "pdf", arguments: { path: pdfPath, question: "What is on page 2?" }, echo: true } }, { text: " I'll read it." }]], prompt: [{ text: "The reader could not run." }] });
	const chat = lessonChat("Antigravity pdf");
	t.after(() => jobStore.deleteJobsForChat(chat.id));
	// Past the probe: the teacher's loadout (which has the pdf tool) is declared.
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	chatStore.saveMessages(chat.id, [
		{ role: "user", id: "u1", content: "Teach me fractions", timestamp: 1 },
		{ role: "assistant", id: "a1", content: [{ type: "toolCall", id: "probe-1", name: "probe_done", arguments: {} }], api: "antigravity-acp", provider: "antigravity", model: "gemini-3-pro", usage, stopReason: "toolUse", timestamp: 2 },
		{ role: "toolResult", id: "r1", toolCallId: "probe-1", toolName: "probe_done", content: [{ type: "text", text: "ok" }], details: { ok: true }, isError: false, timestamp: 3 },
		{ role: "assistant", id: "a2", content: [{ type: "text", text: "Let's start." }], api: "antigravity-acp", provider: "antigravity", model: "gemini-3-pro", usage, stopReason: "stop", timestamp: 4 },
	] as never);
	await settle(chat.id, await handleChatInput(chat.id, { type: "text", text: "Read my PDF" }));
	const listed = (h.log().find((e) => e.kind === "mcp-tools") as unknown as { names: string[] }).names;
	assert.ok(listed.includes("pdf"), `the teacher's tools are declared: ${listed.join(", ")}`);
	// LearnHarness ran the call: a pdf job for exactly that file, and the tool's ack as the call's result.
	const saved = messagesOf(chat.id);
	const call = saved.flatMap((m) => (m.role === "assistant" ? (m.content as { type: string; id?: string; name?: string; arguments?: { path?: string } }[]) : [])).find((b) => b.type === "toolCall" && b.name === "pdf")!;
	assert.equal(call.arguments?.path, pdfPath);
	assert.equal(jobStore.findJobByToolCallId(chat.id, call.id!)?.kind, "pdf");
	const ack = saved.find((m) => m.role === "toolResult" && m.toolCallId === call.id) as { content: { text: string }[]; isError: boolean };
	assert.equal(ack.isError, false);
	assert.match(ack.content[0]!.text, /^Dispatched \(job /);
	// The job runs on the vision slot; none is configured here, so it fails at once and its result re-enters
	// the lesson as a steer, which the Antigravity lesson now accepts (tools switch on). That steer can land
	// in the run right after the ack, before the round resumes: then the waiting prompt expires and the
	// next prompt is a fresh session with the labelled replay (as designed). Either way the lesson goes on.
	await waitFor(() => lastReply(chat.id).text === "The reader could not run.", 10_000, "the job's follow-up turn");
	await waitFor(() => !runningTurn(chat.id), 10_000, "follow-ups settled");
	assert.ok(saved.length > 0 && messagesOf(chat.id).some((m) => m.role === "custom"), "the job's result steer is in the lesson");
	const prompts = h.received().filter((m) => m.method === "session/prompt").map((m) => JSON.stringify(m));
	const resumed = (h.log().filter((e) => e.kind === "mcp-result") as unknown as { result: { isError?: boolean } }[]).some((e) => e.result.isError === false);
	if (!resumed) assert.match(prompts.at(-1)!, /\[tool result pdf\]\\nDispatched/, "replayed with the ack");
	assert.equal(waitingTurnCount(runtime.connection!), 0);
	runtime.shutdown();
	await h.assertNoChildren();
});
