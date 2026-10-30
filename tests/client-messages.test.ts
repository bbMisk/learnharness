import assert from "node:assert/strict";
import { it } from "node:test";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { clientMessage } from "../src/core/client-messages.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { pendingQuestionOf } from "../src/core/native-messages.ts";
import { runPiTurn } from "../src/server/pi/ui-stream.ts";

const image = { type: "image" as const, data: "A".repeat(1_000_000), mimeType: "image/png" };
const assistant: LhMessage = { ...fauxAssistantMessage([
	{ ...fauxThinking("Visible explanation"), thinkingSignature: "opaque".repeat(20_000) },
	fauxText("Look at the attachment."),
	fauxToolCall("read", { path: "/uploads/image.png" }, { id: "read-1" }),
]), id: "a1" };
const result: LhMessage = { id: "r1", role: "toolResult", toolCallId: "read-1", toolName: "read",
	content: [fauxText("Image read successfully."), image], details: null, isError: false, timestamp: 1 };
const question: LhMessage = { ...fauxAssistantMessage([
	fauxToolCall("ask_user_question", { question: "What do you notice?" }, { id: "ask-1" }),
]), id: "a2" };
const history = [assistant, result, question];

it("removes non-display bytes without changing the rendered conversation or pending question", () => {
	const saved = JSON.stringify(history);
	const display = history.map(clientMessage);
	assert.deepEqual(projectView(display), projectView(history));
	assert.deepEqual(pendingQuestionOf(display), pendingQuestionOf(history));
	assert.equal(JSON.stringify(history), saved, "model history and export source must remain untouched");
	assert.ok(JSON.stringify(display).length < saved.length / 100);
	assert.equal(JSON.stringify(display).includes("thinkingSignature"), false);
	const uploaded: LhMessage = { role: "user", id: "u1", timestamp: 1, content: [fauxText("My screenshot"), image] };
	assert.equal(clientMessage(uploaded), uploaded, "learner attachments retain their original representation");
});

it("slims every live/replay event while persisting native image and signature bytes", async () => {
	const events: AgentEvent[] = [
		{ type: "message_start", message: assistant },
		{ type: "message_update", message: assistant, assistantMessageEvent: {} as never },
		{ type: "message_end", message: assistant },
		{ type: "tool_execution_update", toolCallId: "read-1", toolName: "read", args: {}, partialResult: result },
		{ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result, isError: false },
		{ type: "message_start", message: result },
		{ type: "message_end", message: result },
		{ type: "turn_end", message: assistant, toolResults: [result] },
		{ type: "agent_end", messages: history },
	];
	const original = JSON.stringify(events);
	let listener: (event: AgentEvent) => unknown;
	let persisted: unknown;
	const agent = { state: { messages: history }, subscribe(fn: typeof listener) { listener = fn; return () => {}; },
		async continue() { await Promise.resolve(); for (const event of events) await listener(event); }, abort() {} } as unknown as Agent;
	const turn = runPiTurn({ agent, onFinish(messages) { persisted = messages; }, updateFlushMs: 0 });
	const wire = await new Response(turn.subscribe()).text();
	assert.equal(wire.includes(image.data), false);
	assert.equal(wire.includes("thinkingSignature"), false);
	assert.ok(wire.endsWith("data: [DONE]\n\n"));
	assert.deepEqual(persisted, history);
	assert.equal(JSON.stringify(events), original);
	assert.equal(await new Response(turn.subscribe()).text(), wire, "reattach replay uses the same display boundary");
});


it("subscription completion omits replayed history while persisting native messages", async () => {
 const learner: LhMessage = { role: "user", id: "image-input", timestamp: 1, content: [fauxText("My screenshot"), image] };
 const native = [{ role: "system", content: "Ephemeral prompt" } as never, learner, assistant];
 let listener: (event: AgentEvent) => unknown;
 let persisted: unknown;
 const agent = { state: { messages: native }, subscribe(fn: typeof listener) { listener = fn; return () => {}; },
  async continue() { await Promise.resolve(); listener({ type: "message_start", message: assistant }); listener({ type: "message_end", message: assistant }); listener({ type: "agent_end", messages: native }); }, abort() {} } as unknown as Agent;
 const cycle = { bindRelease() {}, hold(event: AgentEvent) { return event.type === "agent_end"; }, finishNativeCycle() { return { action: "settle", messages: [] }; }, deniedBeforeDispatch: false } as unknown as NonNullable<Parameters<typeof runPiTurn>[0]["requestCycle"]>;
 const handle = runPiTurn({ agent, requestCycle: cycle, onFinish(messages) { persisted = messages; } });
 const wire = await new Response(handle.subscribe()).text();
 const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
 assert.equal(events.find(event => event.type === "agent_end").messages.length, 0);
 assert.ok(wire.length < 10_000, "completion must not replay the learner's image/history");
 assert.ok(wire.endsWith("data: [DONE]\n\n"));
 assert.deepEqual(persisted, [learner, assistant], "native settlement retains attachments and excludes the ephemeral prompt");
 assert.equal(await new Response(handle.subscribe()).text(), wire, "late subscribers receive the same compact terminal");
});
