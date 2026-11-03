/**
 * The live question-type swap on the real request builders (owner,
 * 2026-11-03): a teacher run's first model call is answered by a faux reply
 * holding a failed `quiz` call (authoring validation fails, so the run goes
 * on); the lesson then switches to SAQ, and the run's NEXT call is built by
 * pi's real Anthropic Messages and OpenAI Responses providers. The payload is
 * captured at onPayload and the request closed — nothing leaves the process.
 * The request must carry the earlier `quiz` call and its result while
 * declaring only `explain`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

assert.equal(process.env.NODE_ENV, "test", "Run with NODE_ENV=test; these tests must not invoke real providers.");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-question-type-wire-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), ANTHROPIC_API_KEY: "fixture", OPENAI_API_KEY: "fixture" };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };
after(() => {
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	fs.rmSync(directory, { recursive: true, force: true });
});

const { piEngineForSpec } = await import("../src/agent/models.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
type QuestionType = "mcq" | "saq" | "mixed";

async function midRunPayload(provider: string, id: string): Promise<any> {
	const chat = chatStore.createChat(`Wire ${provider}`);
	const real = piEngineForSpec({ provider, id, thinkingLevel: "off" });
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([fauxText("Let me check."), fauxToolCall("quiz", { question: "?" }, { id: "call_quiz" })], { stopReason: "toolUse" })]);
	let type: QuestionType = "mcq";
	let calls = 0;
	const payloads: unknown[] = [];
	const engine = {
		model: real.model,
		streamFn: ((model, context, options) => {
			if (++calls === 1) {
				type = "saq"; // saved between the run's two model calls
				return faux.streamSimple(model, context, options);
			}
			return real.streamFn(model, context, { ...options, onPayload: (value: unknown) => { payloads.push(value); throw new Error("CLOSED: captured payload"); } });
		}) as typeof real.streamFn,
	};
	const teacher = createTeacherAgent(
		{ chatId: chat.id, chatStore, jobStore, spawn: () => {} },
		{
			engine,
			questionType: "mcq",
			liveQuestionType: { current: () => type, projectContextFor: () => "" },
			messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "Teach me limits." }], timestamp: 1 } as never],
		},
	);
	await teacher.continue();
	assert.equal(calls, 2, "the failed quiz kept the run going into a second call");
	assert.equal(payloads.length, 1);
	return payloads[0];
}

test("Anthropic Messages: the earlier quiz tool_use and its result ride on; only explain is declared", async () => {
	const body = await midRunPayload("anthropic", "claude-opus-5-5");
	const declared = body.tools.map((t: { name: string }) => t.name);
	assert.ok(declared.includes("explain") && !declared.includes("quiz"));
	const blocks = body.messages.flatMap((m: { content: unknown }) => (Array.isArray(m.content) ? m.content : []));
	const use = blocks.find((b: any) => b.type === "tool_use" && b.name === "quiz");
	assert.ok(use, "the quiz call stays in the history");
	assert.ok(blocks.some((b: any) => b.type === "tool_result" && b.tool_use_id === use.id), "paired with its result");
});

test("OpenAI Responses: the earlier quiz function_call and its output ride on; only explain is declared", async () => {
	const body = await midRunPayload("openai", "gpt-6.1-sol");
	const declared = [
		...(body.tools ?? []),
		...body.input.filter((i: any) => i.type === "additional_tools").flatMap((i: any) => i.tools),
	].map((t: { name: string }) => t.name);
	assert.ok(declared.includes("explain") && !declared.includes("quiz"), `declared: ${declared.join(", ")}`);
	const call = body.input.find((i: any) => i.type === "function_call" && i.name === "quiz");
	assert.ok(call, "the quiz call stays in the history");
	assert.ok(body.input.some((i: any) => i.type === "function_call_output" && i.call_id === call.call_id), "paired with its output");
});
