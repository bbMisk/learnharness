/**
 * The per-lesson question type (owner, 2026-11-03): MCQ / SAQ / Mixed,
 * stored per chat (ChatSettings.questionType). The stored value and its
 * write gate, the effective-value resolution, the teacher's exact quizzing
 * tools, the prompt text, and the chat handler end to end — a change applies
 * from the tutor's next request, the prober and practice keep today's
 * behaviour, and the shared handoff's update reflects the lesson's type.
 * Scripted faux engine, temp data; nothing leaves the process.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, type Context, type Model, type Api } from "@earendil-works/pi-ai";
import type { AgentBuildOptions, TeachingAgent } from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { ChatSettings, QuestionType } from "../src/core/contracts.ts";

assert.equal(process.env.NODE_ENV, "test", "Run with NODE_ENV=test; these tests must not invoke real providers.");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-question-type-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY = "test-key-presence-gate";
fs.mkdirSync(process.env.LH_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { createPracticeAgent, createProberAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
const { HANDOFF_UPDATE_TEXT } = await import("../src/agent/shared-handoff.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { parseSettingsBody } = await import("../src/server/settings-body.ts");
const { chatStore, setChatOrganization } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { CRAM_INSTRUCTIONS, cramInstructions, withTeachingStyle } = await import("../src/core/cram.ts");
const { MIXED_QUESTION_RULE, QUESTION_TYPE_LABEL, appQuestionType, effectiveQuestionType, sanitizeQuestionType } = await import("../src/core/question-type.ts");
const settingsRoute = await import("../app/api/chats/[id]/settings/route.ts");
const { subscribe } = await import("../src/core/events.ts");
const sectionRoute = await import("../app/api/settings/[section]/route.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const MIXED =
	"Use multiple choice (quiz) by default; use short answer (explain) when he should produce the answer himself rather than recognize it among options — code, vocabulary, a brief proof or derivation, a computed value with its working, or anything the options would give away — and whenever your judgement says writing it out will show or build his understanding better.";
const OLD_CRAM_SENTENCE =
	"Use multiple choice (quiz) by default; use short answer (explain) when the answer is best written out: a derivation, a proof, a computed value with its working, or anything the options would give away.";
const MODEL = { provider: "openrouter", id: "z-ai/glm-5.3-flash" };

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

const ctx = (chatId: string) => ({ chatId, chatStore, jobStore, spawn: () => {} });
const quizzing = (tools: Record<string, unknown>) => Object.keys(tools).filter((n) => n === "quiz" || n === "explain" || n === "probe" || n === "recall").sort();

describe("the stored value", () => {
	it("sanitizes: only the three known types survive a read", () => {
		for (const type of ["mcq", "saq", "mixed"] as const) assert.equal(sanitizeQuestionType(type), type);
		for (const junk of [undefined, null, "", "MCQ", "both", 1, {}, ["mcq"]]) assert.equal(sanitizeQuestionType(junk), undefined);
		assert.deepEqual(QUESTION_TYPE_LABEL, { mcq: "MCQ", saq: "SAQ", mixed: "Mixed" });
	});

	it("the settings body accepts a known type and rejects anything else", () => {
		assert.deepEqual(parseSettingsBody({ model: MODEL, questionType: "saq" }), { ok: true, settings: { model: MODEL, questionType: "saq" } });
		assert.deepEqual(parseSettingsBody({ questionType: "mixed" }), { ok: true, settings: { questionType: "mixed" } });
		assert.deepEqual(parseSettingsBody({ model: MODEL }), { ok: true, settings: { model: MODEL } }, "absent stays absent");
		const bad = parseSettingsBody({ questionType: "essay" });
		assert.equal(bad.ok, false);
		assert.match(!bad.ok ? bad.error : "", /questionType must be one of mcq, saq, mixed/);
	});

	it("round-trips through the record; an old record without it keeps working", () => {
		const chat = chatStore.createChat("Round trip");
		chatStore.saveSettings(chat.id, { model: MODEL, questionType: "mixed" });
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, { model: MODEL, questionType: "mixed" });
		const old = chatStore.createChat("Old record");
		chatStore.saveSettings(old.id, { model: MODEL, thinkingLevel: "low" });
		assert.equal(chatStore.getChat(old.id)!.settings!.questionType, undefined);
		assert.equal(effectiveQuestionType(chatStore.getChat(old.id)!.settings?.questionType, false, undefined), "mcq");
	});
});

describe("the settings route", () => {
	const put = async (id: string, body: unknown) => {
		const response = await settingsRoute.PUT(
			new Request(`http://test/api/chats/${id}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
			{ params: Promise.resolve({ id }) },
		);
		return { status: response.status, body: (await response.json()) as { settings?: ChatSettings; error?: string } };
	};

	it("saves the type with the model fields, and a model-only write keeps it", async () => {
		const chat = chatStore.createChat("Route");
		chatStore.saveSettings(chat.id, { model: MODEL, thinkingLevel: "low" });
		const saved = await put(chat.id, { model: MODEL, thinkingLevel: "low", questionType: "saq" });
		assert.equal(saved.status, 200, saved.body.error);
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, { model: MODEL, thinkingLevel: "low", questionType: "saq" });
		// The model picker's replace-whole write never names it: it stays.
		const picked = await put(chat.id, { model: MODEL, thinkingLevel: "low" });
		assert.equal(picked.status, 200, picked.body.error);
		assert.equal(chatStore.getChat(chat.id)!.settings!.questionType, "saq");
		assert.equal(picked.body.settings!.questionType, "saq", "the response is the stored truth");
		const changed = await put(chat.id, { model: MODEL, thinkingLevel: "low", questionType: "mixed" });
		assert.equal(changed.status, 200);
		assert.equal(chatStore.getChat(chat.id)!.settings!.questionType, "mixed");
	});

	it("field-level: a { questionType } write keeps the model pair; a model write keeps the type; {} changes nothing", async () => {
		const chat = chatStore.createChat("Field level");
		chatStore.saveSettings(chat.id, { model: MODEL, thinkingLevel: "low" });
		assert.equal((await put(chat.id, { questionType: "mixed" })).status, 200);
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, { model: MODEL, thinkingLevel: "low", questionType: "mixed" });
		// The picker's {model} replaces the model pair — a stale level clears, as before.
		assert.equal((await put(chat.id, { model: MODEL })).status, 200);
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, { model: MODEL, questionType: "mixed" });
		assert.equal((await put(chat.id, {})).status, 200);
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, { model: MODEL, questionType: "mixed" });
		// A full object still replaces every group it names.
		assert.equal((await put(chat.id, { model: MODEL, thinkingLevel: "low", questionType: "saq" })).status, 200);
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, { model: MODEL, thinkingLevel: "low", questionType: "saq" });
	});

	it("a question-type write leaves a stored thinking pin exactly as it was; a model write still clamps it", async () => {
		const chat = chatStore.createChat("Pin");
		// The catalog clamps xhigh to max for this model — but only a write
		// that names the model pair may apply that.
		chatStore.saveSettings(chat.id, { model: MODEL, thinkingLevel: "xhigh" });
		assert.equal((await put(chat.id, { questionType: "saq" })).status, 200);
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, { model: MODEL, thinkingLevel: "xhigh", questionType: "saq" });
		assert.equal((await put(chat.id, { model: MODEL, thinkingLevel: "xhigh" })).status, 200);
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, { model: MODEL, thinkingLevel: "max", questionType: "saq" });
	});

	it("a saved Settings section tells every open window to refetch it", async () => {
		const seen: unknown[] = [];
		const off = subscribe((event) => seen.push(event));
		try {
			const response = await sectionRoute.PUT(
				new Request("http://test/api/settings/agent", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tools: { explain: true } }) }),
				{ params: Promise.resolve({ section: "agent" }) },
			);
			assert.equal(response.status, 200);
		} finally {
			off();
			writeSettings({ version: 1, graph: { enabled: false } });
		}
		assert.deepEqual(seen.filter((e) => (e as { type: string }).type === "settings-changed"), [{ type: "settings-changed", section: "agent" }]);
	});

	it("a saved write tells open views of the chat to refetch", async () => {
		const chat = chatStore.createChat("Event");
		chatStore.saveSettings(chat.id, { model: MODEL });
		const seen: unknown[] = [];
		const off = subscribe((event) => seen.push(event));
		try {
			assert.equal((await put(chat.id, { questionType: "saq" })).status, 200);
			assert.equal((await put(chat.id, { questionType: "essay" })).status, 400);
		} finally {
			off();
		}
		assert.deepEqual(seen.filter((e) => (e as { type: string }).type === "record-changed"), [{ type: "record-changed", chatId: chat.id }], "once, for the saved write only");
	});

	it("rejects an unknown type and writes nothing", async () => {
		const chat = chatStore.createChat("Route reject");
		chatStore.saveSettings(chat.id, { model: MODEL, questionType: "mcq" });
		const rejected = await put(chat.id, { model: MODEL, questionType: "essay" });
		assert.equal(rejected.status, 400);
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, { model: MODEL, questionType: "mcq" });
	});

	it("re-sending the session's saved model never trips the catalog gate; a new unknown model still does", async () => {
		const gone = { provider: "nowhere", id: "retired-model" };
		const chat = chatStore.createChat("Route disconnected");
		chatStore.saveSettings(chat.id, { model: gone });
		const kept = await put(chat.id, { model: gone, questionType: "saq" });
		assert.equal(kept.status, 200, kept.body.error);
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, { model: gone, questionType: "saq" });
		const other = chatStore.createChat("Route new model");
		chatStore.saveSettings(other.id, { model: MODEL });
		assert.equal((await put(other.id, { model: gone })).status, 400);
	});

	/** A PUT whose body is still arriving: the route has started (and could
	 *  have read the record) before `release` sends the body. */
	const slowPut = (id: string, body: unknown) => {
		let release!: () => void;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				release = () => {
					controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
					controller.close();
				};
			},
		});
		const request = new Request(`http://test/api/chats/${id}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
		const response = settingsRoute.PUT(request, { params: Promise.resolve({ id }) });
		return { release, response: response.then(async (r) => ({ status: r.status, body: (await r.json()) as { settings?: ChatSettings; error?: string } })) };
	};
	const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

	it("a write that started while a disconnected model was saved is checked against the CURRENT model", async () => {
		const gone = { provider: "nowhere", id: "retired-model" };
		const chat = chatStore.createChat("Race: validation");
		chatStore.saveSettings(chat.id, { model: gone });
		const stale = slowPut(chat.id, { model: gone, questionType: "saq" });
		await tick();
		assert.equal((await put(chat.id, { model: MODEL })).status, 200, "another view moves to a connected model");
		stale.release();
		const result = await stale.response;
		assert.equal(result.status, 400, "re-introducing the disconnected model is a catalog change now");
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, { model: MODEL });
	});

	it("a model write still arriving never restores an older question type", async () => {
		const chat = chatStore.createChat("Race: question type");
		chatStore.saveSettings(chat.id, { model: MODEL, questionType: "mcq" });
		const model = slowPut(chat.id, { model: MODEL, thinkingLevel: "low" });
		await tick();
		assert.equal((await put(chat.id, { questionType: "mixed" })).status, 200);
		model.release();
		assert.equal((await model.response).status, 200);
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, { model: MODEL, thinkingLevel: "low", questionType: "mixed" });
	});
});

describe("effective value", () => {
	it("unset: cram lessons Mixed, other lessons the app-wide mechanic; an explicit value wins", () => {
		assert.equal(appQuestionType(undefined), "mcq");
		assert.equal(appQuestionType({ explain: false }), "mcq");
		assert.equal(appQuestionType({ explain: true }), "saq");
		assert.equal(effectiveQuestionType(undefined, true, undefined), "mixed");
		assert.equal(effectiveQuestionType(undefined, true, { explain: true }), "mixed");
		assert.equal(effectiveQuestionType(undefined, false, undefined), "mcq");
		assert.equal(effectiveQuestionType(undefined, false, { explain: true }), "saq");
		for (const type of ["mcq", "saq", "mixed"] as const) {
			assert.equal(effectiveQuestionType(type, true, undefined), type);
			assert.equal(effectiveQuestionType(type, false, { explain: true }), type);
		}
		assert.equal(effectiveQuestionType("essay", true, undefined), "mixed", "a junk stored value reads as unset");
	});
});

describe("tool sets", () => {
	const all = (tools: Record<string, unknown>) => Object.keys(tools).sort();
	const without = (names: string[], drop: string[]) => names.filter((n) => !drop.includes(n));

	it("teach lessons: MCQ = quiz, SAQ = explain, Mixed = both; everything else as today", () => {
		const today = all(createTeacherTools(ctx("t") as never));
		assert.ok(today.includes("quiz") && !today.includes("explain"));
		assert.deepEqual(quizzing(createTeacherTools(ctx("t") as never, undefined, "mcq")), ["quiz"]);
		assert.deepEqual(quizzing(createTeacherTools(ctx("t") as never, undefined, "saq")), ["explain"]);
		assert.deepEqual(quizzing(createTeacherTools(ctx("t") as never, undefined, "mixed")), ["explain", "quiz"]);
		// The type outranks the app mechanic; unset falls back to it.
		assert.deepEqual(quizzing(createTeacherTools(ctx("t") as never, { explain: true }, "mcq")), ["quiz"]);
		assert.deepEqual(quizzing(createTeacherTools(ctx("t") as never, { explain: true })), ["explain"]);
		for (const type of ["mcq", "saq", "mixed"] as const) {
			assert.deepEqual(
				without(all(createTeacherTools(ctx("t") as never, undefined, type)), ["quiz", "explain"]),
				without(today, ["quiz", "explain"]),
				`${type}: only the quizzing tools differ`,
			);
		}
	});

	it("cram lessons: the same quizzing tools per type, plus the problem set", () => {
		const expected: Record<QuestionType, string[]> = { mcq: ["quiz"], saq: ["explain"], mixed: ["explain", "quiz"] };
		for (const type of ["mcq", "saq", "mixed"] as const) {
			const tools = createTeacherTools(ctx("c") as never, undefined, type, true);
			assert.deepEqual(quizzing(tools), expected[type]);
			assert.ok("problem_list" in tools && "problem_done" in tools);
		}
	});
});

describe("prompt text", () => {
	const project = "## Current project: Optics";

	it("teach lessons: the Mixed sentence for the teacher of a Mixed lesson only", () => {
		assert.equal(MIXED_QUESTION_RULE, MIXED);
		assert.equal(withTeachingStyle(project, { messages: probeDone }, true, "mixed"), `${project}\n\n${MIXED}`);
		assert.equal(withTeachingStyle("", { messages: probeDone }, true, "mixed"), MIXED);
		assert.equal(withTeachingStyle(project, { messages: probeDone }, true, "mcq"), project);
		assert.equal(withTeachingStyle(project, { messages: probeDone }, true, "saq"), project);
		assert.equal(withTeachingStyle(project, { messages: probeDone }), project);
		assert.equal(withTeachingStyle(project, { messages: [] }, true, "mixed"), project, "never the prober");
		assert.equal(withTeachingStyle(project, { kind: "practice", messages: probeDone }, true, "mixed"), project, "never practice");
	});

	it("cram lessons: step 3's sentence per type, naming only the tools the teacher holds", () => {
		const step3 = (text: string) => text.split("\n").find((line) => line.startsWith("3. "))!;
		const lead = "3. Always ask the learner to solve an equivalent full problem before moving on: the problem they brought, or, if they brought none, a typical test instance of the class. Write out the full problem in the question. ";
		assert.equal(step3(cramInstructions("mixed")), lead + MIXED);
		assert.equal(step3(cramInstructions("mcq")), lead + "Use multiple choice (quiz).");
		assert.equal(step3(cramInstructions("saq")), lead + "Use short answer (explain).");
		assert.equal(cramInstructions(), cramInstructions("mixed"), "unset is Mixed");
		assert.equal(CRAM_INSTRUCTIONS, cramInstructions("mixed"));
		for (const type of ["mcq", "saq", "mixed"] as const) assert.ok(!cramInstructions(type).includes(OLD_CRAM_SENTENCE), "the old sentence is gone");
		assert.ok(!cramInstructions("mcq").includes("explain"), "MCQ never mentions explain");
		assert.ok(!cramInstructions("saq").includes("(quiz)"), "SAQ never mentions quiz");
		// Only the step-3 sentence differs between the variants.
		assert.equal(cramInstructions("mcq").replace("Use multiple choice (quiz).", MIXED), cramInstructions("mixed"));
		assert.equal(cramInstructions("saq").replace("Use short answer (explain).", MIXED), cramInstructions("mixed"));
		const cram = { style: "cram" as const, messages: probeDone };
		assert.equal(withTeachingStyle(project, cram, true, "mcq"), `${project}\n\n${cramInstructions("mcq")}`);
		assert.equal(withTeachingStyle(project, cram, true, "saq"), `${project}\n\n${cramInstructions("saq")}`);
		assert.equal(withTeachingStyle(project, cram, true, "mixed"), `${project}\n\n${cramInstructions("mixed")}`);
		assert.equal(withTeachingStyle(project, cram), `${project}\n\n${cramInstructions("mixed")}`);
		assert.ok(!withTeachingStyle(project, cram, true, "mixed").includes(`${MIXED}\n\n${MIXED}`), "a cram lesson gets the rule once, inside step 3");
		assert.equal(withTeachingStyle(project, cram, true, "mixed").split(MIXED).length, 2);
	});
});

// ─── through the chat handler ───────────────────────────────────────────────

type Seen = { opts: AgentBuildOptions & { teaching: boolean }; context: Context };

/** A faux engine that records every request the model receives. */
function recordingEngine(replies: number, model?: (base: Model<Api>) => Model<Api>) {
	const faux = createFauxCore({});
	faux.setResponses(Array.from({ length: replies }, () => fauxAssistantMessage([fauxText("Next step.")])));
	const contexts: Context[] = [];
	const engine: PiEngine = {
		model: model ? model(faux.getModel()) : faux.getModel(),
		streamFn: (m, context, options) => {
			contexts.push(structuredClone(context));
			return faux.streamSimple(m, context, options);
		},
	};
	return { engine, contexts };
}

async function turn(chatId: string, engine: PiEngine, contexts: Context[]): Promise<Seen> {
	let opts: (AgentBuildOptions & { teaching: boolean }) | undefined;
	const record = chatStore.getChat(chatId)!;
	const factory = (o: AgentBuildOptions & { teaching: boolean }): TeachingAgent => {
		opts = o;
		if (record.kind === "practice") return createPracticeAgent({ chatId, chatStore, graphNodes: () => [] } as never, { ...o, engine });
		return o.teaching
			? createTeacherAgent(ctx(chatId) as never, { ...o, engine })
			: createProberAgent({ ...ctx(chatId), deliver: () => {} } as never, { ...o, engine });
	};
	const before = contexts.length;
	const ack = await handleChatRequest(
		new Request("http://test/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId, input: { type: "text", text: "Go on." } }),
		}),
		factory,
	);
	assert.equal(ack.status, 200, await ack.clone().text());
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
	assert.equal(contexts.length, before + 1, "one model request per turn");
	return { opts: opts!, context: contexts.at(-1)! };
}

/** The request's system messages: pi seeds the agent's prompt and tool
 *  declarations as the leading one; a shared handoff adds the teacher's update. */
type System = { role: "system"; content: string; toolsAdded?: Array<{ name: string }>; toolsRemoved?: Array<{ name: string }> };
const systems = (context: Context) => (context.messages as unknown as System[]).filter((m) => m.role === "system");
/** The agent's prompt: the leading system message. */
const prompt = (context: Context) => systems(context)[0]!.content;
/** The tools the request leaves the model with: every system message's changes, in order. */
const toolNames = (context: Context) => {
	const names = new Set<string>();
	for (const message of systems(context)) {
		for (const tool of message.toolsAdded ?? []) names.add(tool.name);
		for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
	}
	return [...names].sort();
};
const quizTools = (context: Context) => toolNames(context).filter((n) => ["quiz", "explain", "probe", "recall"].includes(n));

/** The chip's write: only the question type. */
async function choose(chatId: string, questionType: QuestionType) {
	const response = await settingsRoute.PUT(
		new Request(`http://test/api/chats/${chatId}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ questionType }) }),
		{ params: Promise.resolve({ id: chatId }) },
	);
	assert.equal(response.status, 200);
}

describe("the chat handler", () => {
	it("a change mid-lesson applies from the teacher's next request", async () => {
		writeSettings({ version: 1, graph: { enabled: false } });
		const chat = chatStore.createChat("Mid-lesson");
		chatStore.saveSettings(chat.id, { model: MODEL });
		chatStore.saveMessages(chat.id, probeDone);
		const { engine, contexts } = recordingEngine(5);

		const unset = await turn(chat.id, engine, contexts);
		assert.equal(unset.opts.teaching, true);
		assert.equal(unset.opts.questionType, "mcq", "unset teach lesson: the app mechanic");
		assert.deepEqual(quizTools(unset.context), ["quiz"]);
		assert.ok(!prompt(unset.context).includes(MIXED));

		await choose(chat.id, "mixed");
		const mixed = await turn(chat.id, engine, contexts);
		assert.equal(mixed.opts.questionType, "mixed");
		assert.deepEqual(quizTools(mixed.context), ["explain", "quiz"]);
		assert.ok(prompt(mixed.context).endsWith(`\n\n${MIXED}`), "the Mixed rule rides the teacher's prompt");
		assert.equal(prompt(mixed.context).split(MIXED).length, 2);

		await choose(chat.id, "saq");
		const saq = await turn(chat.id, engine, contexts);
		assert.deepEqual(quizTools(saq.context), ["explain"]);
		assert.ok(!prompt(saq.context).includes(MIXED));
		// Only the quizzing tools moved between the MCQ and SAQ requests.
		assert.deepEqual(toolNames(saq.context).filter((n) => n !== "explain"), toolNames(unset.context).filter((n) => n !== "quiz"));
		assert.equal(prompt(saq.context), prompt(unset.context));

		// A model pick (no questionType in its body) keeps the lesson's type.
		const picked = await settingsRoute.PUT(
			new Request(`http://test/api/chats/${chat.id}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: MODEL }) }),
			{ params: Promise.resolve({ id: chat.id }) },
		);
		assert.equal(picked.status, 200);
		const afterPick = await turn(chat.id, engine, contexts);
		assert.deepEqual(quizTools(afterPick.context), ["explain"]);

		// The app-wide mechanic no longer reaches a lesson with its own choice.
		writeSettings({ version: 1, graph: { enabled: false }, agent: { tools: { explain: false } } });
		await choose(chat.id, "mcq");
		const mcq = await turn(chat.id, engine, contexts);
		assert.deepEqual(quizTools(mcq.context), ["quiz"]);
	});

	it("cram lessons: unset is Mixed; MCQ and SAQ narrow both the tools and step 3", async () => {
		writeSettings({ version: 1, graph: { enabled: false }, agent: { tools: { explain: true } } });
		const chat = chatStore.createChat("Cram lesson");
		chatStore.saveSettings(chat.id, { model: MODEL });
		chatStore.saveMessages(chat.id, probeDone);
		setChatOrganization(chat.id, { style: "cram" });
		const { engine, contexts } = recordingEngine(3);

		const unset = await turn(chat.id, engine, contexts);
		assert.equal(unset.opts.questionType, "mixed", "cram ignores the app mechanic when unset");
		assert.deepEqual(quizTools(unset.context), ["explain", "quiz"]);
		assert.ok(prompt(unset.context).includes(cramInstructions("mixed")));

		await choose(chat.id, "mcq");
		const mcq = await turn(chat.id, engine, contexts);
		assert.deepEqual(quizTools(mcq.context), ["quiz"]);
		assert.ok(prompt(mcq.context).includes(cramInstructions("mcq")));
		assert.ok(!prompt(mcq.context).includes(MIXED));
		assert.ok(toolNames(mcq.context).includes("problem_list"));

		await choose(chat.id, "saq");
		const saq = await turn(chat.id, engine, contexts);
		assert.deepEqual(quizTools(saq.context), ["explain"]);
		assert.ok(prompt(saq.context).includes(cramInstructions("saq")));
	});

	it("the prober keeps the app mechanic and no rule, whatever the lesson's type", async () => {
		writeSettings({ version: 1, graph: { enabled: false } });
		const { engine, contexts } = recordingEngine(4);
		for (const [mechanic, expected] of [[undefined, ["probe"]], [{ explain: true }, ["recall"]]] as const) {
			writeSettings({ version: 1, graph: { enabled: false }, ...(mechanic ? { agent: { tools: mechanic } } : {}) });
			for (const type of ["saq", "mixed"] as const) {
				const chat = chatStore.createChat(`Probing ${type}`);
				chatStore.saveSettings(chat.id, { model: MODEL, questionType: type });
				const probing = await turn(chat.id, engine, contexts);
				assert.equal(probing.opts.teaching, false);
				assert.deepEqual(quizTools(probing.context), [...expected]);
				assert.deepEqual(toolNames(probing.context), Object.keys(createProberTools({ ...ctx(chat.id), deliver: () => {} } as never, mechanic)).sort());
				assert.ok(!prompt(probing.context).includes(MIXED));
			}
		}
	});

	it("practice sessions never read it", async () => {
		writeSettings({ version: 1, graph: { enabled: false } });
		const chat = chatStore.createChat("Drill", "practice");
		chatStore.saveSettings(chat.id, { model: MODEL, questionType: "mixed" });
		const { engine, contexts } = recordingEngine(1);
		const practice = await turn(chat.id, engine, contexts);
		assert.equal(practice.opts.questionType, undefined);
		assert.deepEqual(quizTools(practice.context), []);
		assert.ok(!prompt(practice.context).includes(MIXED));
	});

	it("shared handoff: the teacher's update carries the Mixed rule and its tools; the prober's prefix does not", async () => {
		writeSettings({ version: 1, graph: { enabled: false }, general: { sharedHandoffPrefix: true } });
		const chat = chatStore.createChat("Shared handoff");
		chatStore.saveSettings(chat.id, { model: MODEL, questionType: "mixed" });
		chatStore.saveMessages(chat.id, probeDone);
		const eligible = (base: Model<Api>) => ({ ...base, api: "openai-responses", compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true } }) as Model<Api>;
		const { engine, contexts } = recordingEngine(2, eligible);

		const mixed = await turn(chat.id, engine, contexts);
		assert.ok(mixed.opts.sharedHandoff, "the experiment is on for this teacher");
		const [leading, update] = systems(mixed.context);
		assert.ok(leading && update, "the prober's leading message and the teacher's update");
		assert.ok(!leading.content.includes(MIXED), "the prober's prefix never carries the rule");
		assert.ok(update.content.startsWith(HANDOFF_UPDATE_TEXT));
		assert.ok(update.content.endsWith(`\n\n${MIXED}`));
		assert.deepEqual((update.toolsAdded ?? []).map((t) => t.name).filter((n) => n === "quiz" || n === "explain").sort(), ["explain", "quiz"]);

		await choose(chat.id, "mcq");
		const mcq = await turn(chat.id, engine, contexts);
		const [lead2, update2] = systems(mcq.context);
		assert.equal(lead2!.content, leading.content, "the prober's prefix is stable across the change");
		assert.ok(!update2!.content.includes(MIXED));
		assert.deepEqual((update2!.toolsAdded ?? []).map((t) => t.name).filter((n) => n === "quiz" || n === "explain"), ["quiz"]);
		assert.deepEqual(quizTools(mcq.context), ["quiz"]);
	});
});
