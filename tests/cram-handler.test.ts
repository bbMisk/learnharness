/**
 * Cram mode end to end through the chat handler: the teacher of a cram
 * session gets the cram instructions in its system prompt; a Teach session
 * and a still-probing session do not. Scripted faux engine, temp data.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { AgentBuildOptions, TeachingAgent } from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

assert.equal(process.env.NODE_ENV, "test", "Run with NODE_ENV=test; these tests must not invoke real providers.");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cram-handler-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
fs.mkdirSync(process.env.LH_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { createProberAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore, setChatOrganization } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const probeDone: LhMessage[] = [
	{
		id: "probe",
		role: "assistant",
		content: [{ type: "toolCall", id: "call_probe", name: "probe_done", arguments: { assessment: "Knows the basics." } }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: 1,
	} as never,
	{
		id: "probe-result",
		role: "toolResult",
		toolCallId: "call_probe",
		toolName: "probe_done",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 2,
	} as never,
];

/** One turn; returns what the handler built the agent with. */
async function systemContextFor(style: "cram" | undefined, messages: LhMessage[]) {
	const chat = chatStore.createChat("Cram handler");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveMessages(chat.id, messages);
	if (style) setChatOrganization(chat.id, { style });
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([fauxText("Class: thin lenses. Here is a worked example.")])]);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	let seen: { teaching: boolean; projectContext?: string } | undefined;
	const factory = (opts: AgentBuildOptions & { teaching: boolean }): TeachingAgent => {
		seen = { teaching: opts.teaching, projectContext: opts.projectContext };
		return opts.teaching
			? createTeacherAgent(undefined, { ...opts, engine })
			: createProberAgent({ chatId: chat.id, chatStore, jobStore, deliver: () => {}, spawn: () => {} }, { ...opts, engine });
	};
	const ack = await handleChatRequest(
		new Request("http://test/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId: chat.id, input: { type: "text", text: "Let's cram: get me test-ready on this." } }),
		}),
		factory,
	);
	assert.equal(ack.status, 200);
	const handle = runningTurn(chat.id);
	if (handle) await new Response(handle.subscribe()).text();
	return seen!;
}

it("a cram session's teacher gets the cram instructions; Teach and the probe do not", async () => {
	const cram = await systemContextFor("cram", probeDone);
	assert.equal(cram.teaching, true);
	assert.match(cram.projectContext ?? "", /# Cram mode/);
	const teach = await systemContextFor(undefined, probeDone);
	assert.equal(teach.teaching, true);
	assert.doesNotMatch(teach.projectContext ?? "", /Cram mode/);
	const probing = await systemContextFor("cram", []);
	assert.equal(probing.teaching, false);
	assert.doesNotMatch(probing.projectContext ?? "", /Cram mode/);
});
