/**
 * Lesson tracking (owner, 2026-11-02 — src/core/lesson-tracking.ts,
 * src/agent/tools/lesson-tracking.ts): the cram teacher's problem set and
 * every teacher's mistake log. Pins the tools' validation and slim results,
 * the derivation from the record, the scope (problem tools cram-only,
 * mistake tools teacher-only; prompt text exactly where the tools are),
 * the transcript hiding, and one simulated cram lesson through the chat
 * handler with a faux engine. Temp data dir; no network.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type FauxResponseStep,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { AgentBuildOptions, TeachingAgent } from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

assert.equal(process.env.NODE_ENV, "test", "Run with NODE_ENV=test; these tests must not invoke real providers.");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lesson-tracking-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
fs.mkdirSync(process.env.LH_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { composeInstructions, createProberAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
const { practiceTools } = await import("../src/agent/tools/practice.ts");
const { lessonTrackingTools } = await import("../src/agent/tools/lesson-tracking.ts");
const { CRAM_INSTRUCTIONS, CRAM_PROBE_INSTRUCTIONS, withTeachingStyle } = await import("../src/core/cram.ts");
const { deriveLessonTracking, hasLessonTracking, LESSON_TRACKING_TOOLS } = await import("../src/core/lesson-tracking.ts");
const { projectView } = await import("../src/core/view.ts");
const { createViewProjector } = await import("../src/core/view-incremental.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore, setChatOrganization } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const TRACK_SET =
	"Track the set. When teaching starts, call problem_list once with every problem in the set, in order, each with a short label (e.g. 'Q3: CRLB bound'). Call problem_done once the learner has completed that problem's full attempt correctly, after any follow-up. Re-call problem_list only if the set itself changes.";
const MISTAKES =
	"Mistakes. When the learner makes a substantive mistake (a misconception or a wrong step, not a slip or typo), call note_mistake with one short line naming it. When they later complete a problem or check that would have exposed the same mistake and get it right, call resolve_mistake with its id. Never mention these calls to the learner.";
/** The approved wording, ignoring the bold lead-in markup. */
const plain = (s: string) => s.replaceAll("**", "");

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const probeDone: LhMessage[] = [
	{
		id: "probe",
		role: "assistant",
		content: [{ type: "toolCall", id: "call_probe", name: "probe_done", arguments: { assessment: "Knows the basics." } }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage,
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

/** A pi-shaped tool result, persisted the way a turn's results are. */
function toolResultMessage(id: string, toolName: string, result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean }): LhMessage {
	return {
		id,
		role: "toolResult",
		toolCallId: `call_${id}`,
		toolName,
		content: result.content,
		details: result.details,
		isError: result.isError ?? false,
		timestamp: 3,
	} as never;
}

function newChat(messages: LhMessage[] = []): string {
	const chat = chatStore.createChat("Lesson tracking");
	chatStore.saveMessages(chat.id, messages);
	return chat.id;
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");
/** A refusal's error text (results are JSON: { ok: false, error }). */
const errorOf = (r: { content: Array<{ type: string; text?: string }> }) => (JSON.parse(textOf(r)) as { error?: string }).error ?? "";

async function run(tools: Record<string, AgentTool<any>>, name: string, input: unknown) {
	return tools[name]!.execute(`call_${name}`, input as never);
}

describe("lesson-tracking tools: validation, slim results, derivation", () => {
	it("problem_list validates, replaces wholesale; problem_done ticks known ids only", async () => {
		const chatId = newChat();
		const tools = lessonTrackingTools({ chatId, chatStore }, { problems: true });

		// problem_done before any list: helpful error.
		let r = await run(tools, "problem_done", { id: "q1" });
		assert.match(errorOf(r), /No problem list yet — call problem_list first/);

		// Validation: empty, non-slug, duplicate, empty and multi-line labels.
		r = await run(tools, "problem_list", { problems: [] });
		assert.match(errorOf(r), /problems is empty/);
		r = await run(tools, "problem_list", {
			problems: [
				{ id: "Q1", label: "Q1: bias" },
				{ id: "q2", label: "  " },
				{ id: "q3", label: "Q3" },
				{ id: "q3", label: "line one\nline two" },
			],
		});
		const err = errorOf(r);
		assert.match(err, /problems\[0\]\.id "Q1" is not a slug/);
		assert.match(err, /problems\[1\]\.label is empty/);
		assert.match(err, /problems\[3\]\.id "q3" is a duplicate/);
		assert.match(err, /problems\[3\]\.label is too long — one short line/);
		assert.equal((r.details as { ok: boolean }).ok, false);

		// A valid list: slim content (no echo of the labels), full details.
		r = await run(tools, "problem_list", {
			problems: [
				{ id: "q1", label: "Q1: bias of the MLE" },
				{ id: "q2", label: " Q2: CRLB bound " },
				{ id: "q3", label: "Q3: sufficiency" },
			],
		});
		assert.deepEqual(JSON.parse(textOf(r)), { ok: true, problems: 3 });
		assert.doesNotMatch(textOf(r), /CRLB/);
		assert.deepEqual((r.details as { problems: unknown }).problems, [
			{ id: "q1", label: "Q1: bias of the MLE" },
			{ id: "q2", label: "Q2: CRLB bound" },
			{ id: "q3", label: "Q3: sufficiency" },
		]);

		// Unknown id: the error lists the valid ids. A known id ticks.
		r = await run(tools, "problem_done", { id: "q9" });
		assert.match(errorOf(r), /No problem "q9" in the current list\. Ids: q1, q2, q3\./);
		r = await run(tools, "problem_done", { id: "q2" });
		assert.deepEqual(JSON.parse(textOf(r)), { ok: true, done: 1, of: 3 });
	});

	it("note_mistake mints m1, m2… per chat; resolve_mistake needs an open, existing id", async () => {
		const chatId = newChat();
		const tools = lessonTrackingTools({ chatId, chatStore }, { problems: false });
		assert.deepEqual(Object.keys(tools).sort(), ["note_mistake", "resolve_mistake"]);

		let r = await run(tools, "note_mistake", { text: "  " });
		assert.match(errorOf(r), /text is empty/);
		r = await run(tools, "note_mistake", { text: "two\nlines" });
		assert.match(errorOf(r), /one short line/);
		r = await run(tools, "note_mistake", { text: "Treats the variance as the standard deviation" });
		assert.deepEqual(JSON.parse(textOf(r)), { ok: true, id: "m1" });
		r = await run(tools, "note_mistake", { text: "Drops the n in the Fisher information" });
		assert.deepEqual(JSON.parse(textOf(r)), { ok: true, id: "m2" });

		r = await run(tools, "resolve_mistake", { id: "m7" });
		assert.match(errorOf(r), /No mistake "m7"\. Open mistakes: m1, m2\./);
		r = await run(tools, "resolve_mistake", { id: "m1" });
		assert.deepEqual(JSON.parse(textOf(r)), { ok: true });
		r = await run(tools, "resolve_mistake", { id: "m1" });
		assert.match(errorOf(r), /Mistake "m1" is already resolved\. Open mistakes: m2\./);
	});

	it("the state derives from the record's results — a new registry continues from it", async () => {
		const chatId = newChat();
		const first = lessonTrackingTools({ chatId, chatStore }, { problems: true });
		const saved: LhMessage[] = [];
		const keep = async (name: string, input: unknown) => {
			const r = await run(first, name, input);
			saved.push(toolResultMessage(`r${saved.length}`, name, r as never));
			return r;
		};
		await keep("problem_list", { problems: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }] });
		await keep("problem_done", { id: "a" });
		await keep("problem_done", { id: "zzz" }); // refused: never counts
		await keep("note_mistake", { text: "Sign error in the score" });
		await keep("note_mistake", { text: "Confuses MLE with MoM" });
		await keep("resolve_mistake", { id: "m1" });
		// The list REPLACES wholesale; ticks of problems the new list keeps
		// stay (the plan map's rule — completion derives from the record).
		await keep("problem_list", { problems: [{ id: "c", label: "C (rewritten)" }, { id: "a", label: "A" }, { id: "d", label: "D" }] });
		chatStore.saveMessages(chatId, saved);

		const derived = deriveLessonTracking(chatStore.getChat(chatId)!.messages);
		assert.deepEqual(derived, {
			problems: [
				{ id: "c", label: "C (rewritten)", done: false },
				{ id: "a", label: "A", done: true },
				{ id: "d", label: "D", done: false },
			],
			mistakes: [
				{ id: "m1", text: "Sign error in the score", resolved: true },
				{ id: "m2", text: "Confuses MLE with MoM", resolved: false },
			],
		});
		assert.equal(hasLessonTracking(derived), true);
		assert.equal(hasLessonTracking(deriveLessonTracking([])), false);
		assert.deepEqual(deriveLessonTracking([]), { problems: null, mistakes: [] });

		// A fresh registry (the next turn) seeds from the record.
		const next = lessonTrackingTools({ chatId, chatStore }, { problems: true });
		assert.deepEqual(JSON.parse(textOf(await run(next, "note_mistake", { text: "Third one" }))), { ok: true, id: "m3" });
		assert.match(errorOf(await run(next, "problem_done", { id: "b" })), /No problem "b" in the current list\. Ids: c, a, d\./);
		assert.match(errorOf(await run(next, "resolve_mistake", { id: "m1" })), /already resolved/);

		// Error results (isError) never fold, whatever their details.
		const withError = [
			...saved,
			toolResultMessage("bad", "note_mistake", { content: [{ type: "text", text: "boom" }], details: { ok: true, id: "m9", text: "x" }, isError: true }),
		];
		assert.equal(deriveLessonTracking(withError).mistakes.length, 2);
	});
});

describe("lesson-tracking scope", () => {
	const ctx = (chatId: string) => ({ chatId, chatStore, jobStore, spawn: () => {} });
	const tracking = (tools: Record<string, unknown>) => Object.keys(tools).filter((n) => LESSON_TRACKING_TOOLS.includes(n)).sort();

	it("problem tools for a cram teacher only; mistake tools for every teacher; never the prober or practice", () => {
		const chatId = newChat();
		assert.deepEqual(tracking(createTeacherTools(ctx(chatId))), ["note_mistake", "resolve_mistake"]);
		assert.deepEqual(tracking(createTeacherTools(ctx(chatId), undefined, true)), ["note_mistake", "resolve_mistake"], "bothQuizzing alone does not add the problem tools");
		assert.deepEqual(tracking(createTeacherTools(ctx(chatId), { explain: true }, false, false)), ["note_mistake", "resolve_mistake"]);
		assert.deepEqual(tracking(createTeacherTools(ctx(chatId), undefined, true, true)), ["note_mistake", "problem_done", "problem_list", "resolve_mistake"]);
		assert.deepEqual(tracking(createProberTools({ ...ctx(chatId), deliver: () => {} })), []);
		assert.deepEqual(tracking(practiceTools({ chatId, chatStore })), []);
	});

	it("the prompt text rides exactly where the tools are", () => {
		const teacher = plain(composeInstructions("teacher"));
		assert.ok(teacher.includes(MISTAKES), "the teacher (teach + cram) carries the mistakes paragraph");
		assert.doesNotMatch(composeInstructions("prober"), /note_mistake|resolve_mistake/);
		assert.doesNotMatch(composeInstructions("practice"), /note_mistake|resolve_mistake/);
		for (const kind of ["teacher", "prober", "practice"] as const) {
			assert.doesNotMatch(composeInstructions(kind), /problem_list|problem_done/, `${kind}'s base prompt never names the problem tools`);
		}
		// The cram teacher's instructions carry the set paragraph; the cram
		// prober's, a Teach lesson's, and practice's context do not.
		assert.ok(plain(CRAM_INSTRUCTIONS).includes(TRACK_SET));
		assert.doesNotMatch(CRAM_PROBE_INSTRUCTIONS, /problem_list/);
		assert.ok(plain(withTeachingStyle("", { style: "cram", messages: probeDone })).includes(TRACK_SET));
		assert.doesNotMatch(withTeachingStyle("", { style: "cram", messages: [] }), /problem_list/);
		assert.doesNotMatch(withTeachingStyle("", { messages: probeDone }), /problem_list/);
		assert.doesNotMatch(withTeachingStyle("", { style: "cram", kind: "practice", messages: probeDone }), /problem_list/);
	});
});

// ─── the transcript hides the four tools ─────────────────────────────────────

const assistant = (id: string, content: object[]) =>
	({ id, role: "assistant", content, stopReason: "toolUse", usage, provider: "test", model: "test", timestamp: 0 }) as unknown as LhMessage;
const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, toolCallId: string, toolName: string, details: unknown, isError = false) =>
	({ id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], details, isError, timestamp: 0 }) as unknown as LhMessage;

describe("lesson-tracking calls are hidden from the transcript", () => {
	const record: LhMessage[] = [
		{ id: "u1", role: "user", content: "cram me", timestamp: 0 } as never,
		assistant("a1", [
			{ type: "text", text: "Here is the set." },
			call("pl", "problem_list", { problems: [{ id: "q1", label: "Q1" }] }),
			call("nm", "note_mistake", { text: "Sign slip" }),
			call("rd", "read", { path: "notes.md" }),
		]),
		result("r-pl", "pl", "problem_list", { ok: true, problems: [{ id: "q1", label: "Q1" }] }),
		result("r-nm", "nm", "note_mistake", { ok: true, id: "m1", text: "Sign slip" }),
		result("r-rd", "rd", "read", { body: "x" }),
		// A message carrying ONLY tracking calls (one an error) renders nothing.
		assistant("a2", [call("pd", "problem_done", { id: "q9" }), call("rm", "resolve_mistake", { id: "m1" })]),
		result("r-pd", "pd", "problem_done", { tool: "problem_done", problems: ["x"] }, true),
		result("r-rm", "rm", "resolve_mistake", { ok: true, id: "m1" }),
		assistant("a3", [{ type: "text", text: "Next." }]),
	];

	it("projectView renders no part for them — no card, no retry line — and the rest is untouched", () => {
		const view = projectView(record);
		const types = view.flatMap((m) => m.parts.map((p) => p.type));
		for (const name of LESSON_TRACKING_TOOLS) assert.ok(!types.includes(`tool-${name}`), `tool-${name} is hidden`);
		assert.ok(types.includes("tool-read"), "other tool cards still render");
		const texts = view.flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text));
		assert.deepEqual(texts, ["cram me", "Here is the set.", "Next."]);
		// The tracking-only message adds no step of its own: a1 + a3 = one group, one separator.
		const group = view.find((m) => m.role === "assistant")!;
		assert.equal(group.parts.filter((p) => p.type === "step-start").length, 2);
	});

	it("hidden even while streaming live, and the incremental projector agrees", () => {
		const live = { inFlight: true, streamingIds: new Set(["a2"]), executions: new Map() };
		const view = projectView(record.slice(0, 6), live);
		const types = view.flatMap((m) => m.parts.map((p) => p.type));
		assert.ok(!types.some((t) => t === "tool-problem_done" || t === "tool-resolve_mistake"));
		const projector = createViewProjector();
		for (let n = 1; n <= record.length; n++) {
			assert.deepStrictEqual(projector.project(record.slice(0, n), live), projectView(record.slice(0, n), live));
		}
	});
});

// ─── one simulated cram lesson through the chat handler ──────────────────────

function scripted(steps: FauxResponseStep[]): { engine: PiEngine; contexts: string[] } {
	const contexts: string[] = [];
	const faux = createFauxCore({});
	faux.setResponses(
		steps.map((step) => async (context: TranscriptContext): Promise<AssistantMessage> => {
			contexts.push(JSON.stringify(context.messages));
			return step as AssistantMessage;
		}),
	);
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, contexts };
}

async function turn(chatId: string, text: string, engine: PiEngine) {
	const factory = (opts: AgentBuildOptions & { teaching: boolean }): TeachingAgent =>
		opts.teaching
			? createTeacherAgent({ chatId, chatStore, jobStore, spawn: () => {} }, { ...opts, engine })
			: createProberAgent({ chatId, chatStore, jobStore, deliver: () => {}, spawn: () => {} }, { ...opts, engine });
	const ack = await handleChatRequest(
		new Request("http://test/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId, input: { type: "text", text } }),
		}),
		factory,
	);
	assert.equal(ack.status, 200, await ack.clone().text());
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

describe("a simulated cram lesson (chat handler + faux engine)", () => {
	it("the teacher's tracking calls persist; the derived state reads back from the saved record", async () => {
		const chatId = newChat(probeDone);
		chatStore.saveSettings(chatId, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		setChatOrganization(chatId, { style: "cram" });

		const lesson = scripted([
			fauxAssistantMessage(
				[
					fauxText("Three problems. First, the bias of the MLE."),
					fauxToolCall("problem_list", {
						problems: [
							{ id: "q1", label: "Q1: bias of the MLE" },
							{ id: "q2", label: "Q2: CRLB bound" },
							{ id: "q3", label: "Q3: sufficiency" },
						],
					}, { id: "t1-list" }),
					fauxToolCall("note_mistake", { text: "Treats the variance as the standard deviation" }, { id: "t1-m1" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("problem_done", { id: "q1" }, { id: "t1-done" }),
					fauxToolCall("note_mistake", { text: "Drops the n in the Fisher information" }, { id: "t1-m2" }),
					fauxToolCall("resolve_mistake", { id: "m1" }, { id: "t1-r1" }),
					fauxToolCall("problem_done", { id: "q7" }, { id: "t1-bad" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("Q1 is done. On to the CRLB.")]),
		]);
		await turn(chatId, "Let's cram for the stats midterm.", lesson.engine);

		const saved = chatStore.getChat(chatId)!.messages;
		assert.deepEqual(deriveLessonTracking(saved), {
			problems: [
				{ id: "q1", label: "Q1: bias of the MLE", done: true },
				{ id: "q2", label: "Q2: CRLB bound", done: false },
				{ id: "q3", label: "Q3: sufficiency", done: false },
			],
			mistakes: [
				{ id: "m1", text: "Treats the variance as the standard deviation", resolved: true },
				{ id: "m2", text: "Drops the n in the Fisher information", resolved: false },
			],
		});
		// The model saw slim acks (the in-turn m2), and the helpful error.
		const lastContext = lesson.contexts.at(-1)!;
		assert.ok(lastContext.includes(JSON.stringify(JSON.stringify({ ok: true, id: "m2" })).slice(1, -1)));
		assert.match(lastContext, /No problem \\"q7\\" in the current list/);
		assert.doesNotMatch(lastContext, /Q2: CRLB bound\\"[^]*Q2: CRLB bound/, "the list is never echoed back");
		// The transcript shows the prose, never the tracking calls.
		const types = projectView(saved).flatMap((m) => m.parts.map((p) => p.type));
		for (const name of LESSON_TRACKING_TOOLS) assert.ok(!types.includes(`tool-${name}`));

		// Next turn: a fresh registry continues from the saved record.
		const next = scripted([
			fauxAssistantMessage(
				[
					fauxToolCall("problem_done", { id: "q2" }, { id: "t2-done" }),
					fauxToolCall("note_mistake", { text: "Forgets the regularity conditions" }, { id: "t2-m3" }),
					fauxToolCall("resolve_mistake", { id: "m1" }, { id: "t2-again" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("Good. Last one: sufficiency.")]),
		]);
		await turn(chatId, "Done with the CRLB one.", next.engine);
		const after2 = deriveLessonTracking(chatStore.getChat(chatId)!.messages);
		assert.deepEqual(after2.problems?.map((p) => p.done), [true, true, false]);
		assert.deepEqual(after2.mistakes.map((m) => [m.id, m.resolved]), [["m1", true], ["m2", false], ["m3", false]]);
		assert.match(next.contexts.at(-1)!, /already resolved/);
	});

	it("a Teach lesson's teacher has the mistake tools but no problem tools", async () => {
		const chatId = newChat(probeDone);
		chatStore.saveSettings(chatId, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		const lesson = scripted([
			fauxAssistantMessage(
				[
					fauxToolCall("problem_list", { problems: [{ id: "q1", label: "Q1" }] }, { id: "x-list" }),
					fauxToolCall("note_mistake", { text: "Mixes up the chain rule order" }, { id: "x-m1" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("Let's continue.")]),
		]);
		await turn(chatId, "Teach me derivatives.", lesson.engine);
		const derived = deriveLessonTracking(chatStore.getChat(chatId)!.messages);
		assert.equal(derived.problems, null, "problem_list is not in a Teach teacher's registry");
		assert.deepEqual(derived.mistakes, [{ id: "m1", text: "Mixes up the chain rule order", resolved: false }]);
	});
});
