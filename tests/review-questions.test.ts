import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseStep,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { Flashcard } from "../src/core/review.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-questions-"));
process.env.LH_DATA_DIR = temp;
process.env.LH_AUTH_FILE = path.join(temp, "auth.json");
const { stores } = await import("../src/server/stores.ts");
const { piModels } = await import("../src/agent/models.ts");
const { questionFor, questionProblem, SHORT_ANSWER_CHARS } = await import("../src/server/review-questions.ts");
const { triageFlashcards } = await import("../src/server/flashcard-agent.ts");
const { bgLlmSlots } = await import("../src/agent/subagents/bg-llm-semaphore.ts");
const { chatGPTStatus } = await import("../src/agent/chatgpt-bridge.ts");
const { readQuestionCache } = await import("../src/store/review-questions.ts");

// A scripted provider registered in the real model collection, so the curator's
// own engine resolution, gates and slot run unchanged around it.
const faux = fauxProvider({ provider: "faux-curator", models: [{ id: "curator-1" }] });
piModels().setProvider(faux.provider);
const contexts: TranscriptContext[] = [];
function respond(steps: FauxResponseStep[]) {
	contexts.length = 0;
	faux.setResponses(
		steps.map((step) => (context, options, state, model) => {
			contexts.push(context);
			return typeof step === "function" ? step(context, options, state, model) : step;
		}),
	);
}
function card(revision: string): Flashcard {
	return {
		id: `card_${revision}`,
		sourceNodeId: "n_1",
		revision,
		front: "What does a derivative measure?",
		back: "The instantaneous rate of change",
		deckId: "chat_1",
		deckName: "Calculus",
		createdAt: 1,
		active: true,
	};
}
const question = (answer: string) => ({
	prompt: "What does a derivative measure?",
	options: [answer, "The area under a curve", "The average of a function", "The maximum of a function"],
	correctIndex: 0,
	explanation: "A derivative is a limit of difference quotients; the distractors describe integrals, averages and extrema.",
});

beforeEach(() => {
	stores.settingsStore.writeSettings({ version: 1, models: { cheap: { model: { provider: "faux-curator", id: "curator-1" } } } });
	faux.setResponses([]);
});
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const submit = (name: string, input: unknown) =>
	fauxAssistantMessage([fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-${contexts.length}` })]);
/** The tool result the model saw before its latest call. */
const feedback = (call: number) => JSON.stringify(contexts[call]!.messages.at(-1));
const answer = "The instantaneous rate of change";

it("prepares a question through the configured model's submit tool inside a background slot", async () => {
	let slotsDuringCall = -1;
	respond([
		() => {
			slotsDuringCall = bgLlmSlots().active;
			return submit("submit_question", question(answer));
		},
	]);
	const result = await questionFor(card("valid-question"));
	assert.deepEqual(result, question(answer));
	assert.deepEqual(readQuestionCache()["valid-question"], result);
	assert.equal(contexts.length, 1);
	assert.match(JSON.stringify(contexts[0]!.messages), /multiple-choice question/);
	assert.equal(slotsDuringCall, 1);
	assert.equal(bgLlmSlots().active, 0);
});

it("retries a schema-invalid question and accepts the corrected submission", async () => {
	respond([
		submit("submit_question", { ...question(answer), options: [answer, "Only", "Three"] }),
		submit("submit_question", question(answer)),
	]);
	assert.deepEqual(await questionFor(card("invalid-then-valid")), question(answer));
	assert.equal(contexts.length, 2);
	assert.match(feedback(1), /options/);
});

it("retries when the correct option is not the card's answer, and fails cleanly if it never matches", async () => {
	respond([submit("submit_question", question("A rate of change")), submit("submit_question", question(answer))]);
	assert.deepEqual(await questionFor(card("mismatch-then-valid")), question(answer));
	assert.equal(contexts.length, 2);
	assert.match(feedback(1), /source answer copied exactly/);

	respond(Array.from({ length: 4 }, () => submit("submit_question", question("A rate of change"))));
	await assert.rejects(questionFor(card("always-mismatched")), {
		name: "ReviewError",
		status: 409,
		message: /could not prepare a valid question/,
	});
	assert.equal(contexts.length, 4);
	assert.equal(readQuestionCache()["always-mismatched"], undefined);
});

it("triages candidates through the submit tool and retries incomplete decisions", async () => {
	const cards = [card("triage-a"), card("triage-b")];
	const decision = (id: string) => ({ id, keep: true, priority: 80, reason: "Durable concept" });
	respond([
		submit("submit_decisions", { decisions: [decision("c1")] }),
		submit("submit_decisions", { decisions: [decision("c1"), decision("c2")] }),
	]);
	const result = await triageFlashcards(cards, "Prefer definitions.", new AbortController().signal);
	assert.deepEqual(
		result.map((item) => item.revision),
		["triage-a", "triage-b"],
	);
	assert.equal(contexts.length, 2);
	assert.match(feedback(1), /c1 to c2/);
	assert.match(JSON.stringify(contexts[0]!.messages), /Prefer definitions\./);
});

it("refuses before any model call when the key or background access is missing", async () => {
	respond([submit("submit_question", question(answer))]);
	const key = process.env.OPENROUTER_API_KEY;
	delete process.env.OPENROUTER_API_KEY;
	stores.settingsStore.writeSettings({ version: 1, models: { cheap: { model: { provider: "openrouter", id: "openai/gpt-4o-mini" } } } });
	await assert.rejects(questionFor(card("no-key")), { name: "ReviewError", message: /Connect a Cheap model/ });
	if (key !== undefined) process.env.OPENROUTER_API_KEY = key;

	// A connected ChatGPT account whose owner has not allowed background use.
	const env = { server: process.env.LH_DESKTOP_SERVER, secret: process.env.LH_DESKTOP_API_SECRET };
	const send = Object.getOwnPropertyDescriptor(process, "send"),
		connected = Object.getOwnPropertyDescriptor(process, "connected");
	chatGPTStatus();
	process.env.LH_DESKTOP_SERVER = "1";
	process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: () => true });
	try {
		(process.emit as (name: string, value: unknown) => boolean)("message", {
			channel: "lh:chatgpt",
			kind: "state",
			stamp: { epoch: 1, authorityRevision: 1, revision: 1 },
			status: {
				available: true,
				pending: false,
				allowBackgroundUse: false,
				activeId: "account",
				accounts: [
					{
						id: "account",
						email: "learner@example.invalid",
						registration: "oaiapp_fixture",
						connected: true,
						planEnabled: true,
						background: false,
					},
				],
				error: null,
			},
		});
		stores.settingsStore.writeSettings({ version: 1, models: { cheap: { model: { provider: "chatgpt", id: "gpt-5" } } } });
		await assert.rejects(questionFor(card("no-background")), { name: "ReviewError", message: /Enable background access/ });
	} finally {
		for (const [name, value] of [
			["LH_DESKTOP_SERVER", env.server],
			["LH_DESKTOP_API_SECRET", env.secret],
		] as const)
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		if (send) Object.defineProperty(process, "send", send);
		else delete (process as { send?: unknown }).send;
		if (connected) Object.defineProperty(process, "connected", connected);
		else delete (process as { connected?: boolean }).connected;
	}
	assert.equal(contexts.length, 0);
	assert.equal(faux.getPendingResponseCount(), 1);
});

const longBack =
	"In a finite-state pattern race, the probability of a specified pattern eventually winning from a nonterminal state is the probability-weighted average of its win probabilities from the next states.";
const longCard = (revision: string): Flashcard => ({
	...card(revision),
	front: "How do first-step win probabilities combine?",
	back: longBack,
});
const shortQuestion = (explanation = `${longBack} The distractors drop the weighting or the terminal values.`) => ({
	prompt: "In a finite-state pattern race, a nonterminal state's win probability is…",
	options: [
		"The probability-weighted average of the next states' win probabilities",
		"The largest of the next states' win probabilities",
		"The unweighted average of the next states' win probabilities",
		"The smallest of the next states' win probabilities",
	],
	correctIndex: 0,
	explanation,
});

it("condenses a long source answer: short options, and the explanation quotes the full answer", () => {
	assert.ok(longBack.length > SHORT_ANSWER_CHARS);
	assert.equal(questionProblem(longCard("long-ok"), shortQuestion()), null);
	const wordy = { ...shortQuestion(), options: [longBack, ...shortQuestion().options.slice(1)] };
	assert.match(questionProblem(longCard("long-wordy"), wordy)!, /Option 1 has \d+ characters/);
	assert.match(
		questionProblem(longCard("long-unquoted"), shortQuestion("Weighted by transition probability."))!,
		/full source answer copied exactly/,
	);
	// A short answer keeps the exact-copy rule.
	assert.equal(questionProblem(card("short-ok"), question(answer)), null);
	assert.match(questionProblem(card("short-reworded"), question("A rate of change"))!, /source answer copied exactly/);
});

it("asks the model to condense long answers and retries until the options are short", async () => {
	const wordy = { ...shortQuestion(), options: [longBack, ...shortQuestion().options.slice(1)] };
	respond([submit("submit_question", wordy), submit("submit_question", shortQuestion())]);
	assert.deepEqual(await questionFor(longCard("long-retry")), shortQuestion());
	assert.match(JSON.stringify(contexts[0]!.messages), /condensed restatement/);
	assert.match(feedback(1), /Keep every option under 120 characters/);
});
