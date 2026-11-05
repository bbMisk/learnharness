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
const { questionFor, questionProblem, sharedOptionWording, SHORT_ANSWER_CHARS, QUESTION_RULES } = await import("../src/server/review-questions.ts");
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
const question = (answer: string, explanation = "The instantaneous rate of change. A derivative is a limit of difference quotients; the distractors describe integrals, averages and extrema.") => ({
	prompt: "What does a derivative measure?",
	options: [answer, "The area under a curve", "The average of a function", "The maximum of a function"],
	correctIndex: 0,
	explanation,
});
/** As saved and served: marked with the current question rules. */
const saved = (q: ReturnType<typeof question>) => ({ ...q, rules: QUESTION_RULES });

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
	assert.deepEqual(result, saved(question(answer)));
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
	assert.deepEqual(await questionFor(card("invalid-then-valid")), saved(question(answer)));
	assert.equal(contexts.length, 2);
	assert.match(feedback(1), /options/);
});

it("puts the card's answer into an explanation that doesn't quote it, and fails cleanly on repeated invalid submissions", async () => {
	// Round-1 hunt finding: an exact quote is ensured by the code, never a reason to reject.
	const unquoted = question(answer, "Derivatives measure change; the distractors describe other things.");
	respond([submit("submit_question", unquoted)]);
	const result = await questionFor(card("unquoted"));
	assert.equal(contexts.length, 1, "no retry for a missing quote");
	assert.equal(result.explanation, `${answer}\n\nDerivatives measure change; the distractors describe other things.`);
	// Whitespace differences still count as quoted: kept as written.
	const spaced = question(answer, "The instantaneous   rate\nof change. Derivatives measure change.");
	respond([submit("submit_question", spaced)]);
	assert.equal((await questionFor(card("spaced"))).explanation, spaced.explanation);

	const repeated = { ...question(answer), options: ["It is the instantaneous rate of change: A", "It is the instantaneous rate of change: B", "It is the instantaneous rate of change: C", "It is the instantaneous rate of change: D"] };
	respond(Array.from({ length: 4 }, () => submit("submit_question", repeated)));
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
	prompt: "In a finite-state pattern race, a nonterminal state's win probability is which function of the next states' win probabilities?",
	options: ["Their probability-weighted average", "Their largest value", "Their unweighted average", "Their smallest value"],
	correctIndex: 0,
	explanation,
});

it("condenses a long source answer: short options, and the explanation quotes the full answer", () => {
	assert.ok(longBack.length > SHORT_ANSWER_CHARS);
	assert.equal(questionProblem(longCard("long-ok"), shortQuestion()), null);
	const wordy = { ...shortQuestion(), options: [longBack, ...shortQuestion().options.slice(1)] };
	assert.match(questionProblem(longCard("long-wordy"), wordy)!, /Option 1 has \d+ characters/);
	assert.equal(questionProblem(longCard("long-unquoted"), shortQuestion("Weighted by transition probability.")), null, "the code adds the quote");
	// Owner, 2026-11-05: a short answer no longer has to be the correct option verbatim
	// (that forced the whole sentence into every option); the explanation quotes it instead.
	assert.equal(questionProblem(card("short-ok"), question(answer)), null);
	assert.equal(questionProblem(card("short-reworded"), question("A rate of change")), null);

});

it("rejects options that repeat a shared lead-in or formula (the owner's LEC 3 card)", () => {
	const back = "An infinite intersection of open subsets of $\\mathbb{R}$ need not be open: $\\bigcap_{n=1}^\\infty(-1/n,1+1/n)=[0,1]$.";
	const lec3: Flashcard = { ...card("lec3"), front: "Explain: infinite intersection of open sets", back };
	const repeated = {
		prompt: "What does the example of an infinite intersection of open subsets of $\\mathbb{R}$ show?",
		options: [
			"An infinite intersection of open subsets of $\\mathbb{R}$ can include 0 but exclude 1: $[0,1)$.",
			"An infinite intersection of open subsets of $\\mathbb{R}$ need not be open: $[0,1]$.",
			"An infinite intersection of open subsets of $\\mathbb{R}$ is always open: $(0,1)$.",
			"An infinite intersection of open subsets of $\\mathbb{R}$ can exclude 0 but include 1: $(0,1]$.",
		],
		correctIndex: 1,
		explanation: `${back} The other sets get an endpoint wrong.`,
	};
	assert.match(questionProblem(lec3, repeated)!, /All four options begin with "An infinite intersection of open subsets of/);
	const better = {
		prompt: "$\\bigcap_{n=1}^\\infty\\left(-\\tfrac1n,\\ 1+\\tfrac1n\\right) = \\;?$",
		options: ["$[0,1)$", "$[0,1]$", "$(0,1)$", "$(0,1]$"],
		correctIndex: 1,
		explanation: `${back} $0$ and $1$ lie in every interval; anything outside $[0,1]$ is excluded by some $n$.`,
	};
	assert.equal(questionProblem(lec3, better), null);
	// Shared endings count too; short shared bits (a "$", a unit) don't.
	assert.deepEqual(sharedOptionWording(["a, so the set is closed and bounded", "b, so the set is closed and bounded", "c, so the set is closed and bounded", "d, so the set is closed and bounded"])?.where, "end");
	assert.equal(sharedOptionWording(["$[0,1)$", "$[0,1]$", "$(0,1)$", "$(0,1]$"]), null);
	assert.equal(sharedOptionWording(["5 m/s", "10 m/s", "15 m/s", "20 m/s"]), null);
	assert.equal(sharedOptionWording(["The intersection is empty", "The intersection is one point", "The intersection is open", "The intersection is closed"]), null, "a short shared lead-in is fine");
	// Round-1 hunt finding: the same formula in the middle of every option.
	const formula = " so $\\bigcap_{n=1}^\\infty(-1/n,1+1/n)$ is ";
	assert.equal(sharedOptionWording([`1${formula}a`, `2${formula}b`, `3${formula}c`, `4${formula}d`])?.where, "contain");
});

it("a rewrite must keep the correct option where the old question had it (offline reviews; round 1–2 hunt findings)", async () => {
	const { refreshQuestion } = await import("../src/server/review-questions.ts");
	const old: Flashcard = { ...card("rewrite-keeps-index"), mcq: { ...question(answer), correctIndex: 3, options: ["B", "C", "D", answer] } };
	const atThree = { ...question(answer), options: ["The area under a curve", "The average of a function", "The maximum of a function", answer], correctIndex: 3 };
	// The model first ignores the position: sent back, not swapped behind its explanation's back.
	respond([submit("submit_question", question(answer)), submit("submit_question", atThree)]);
	const rewritten = await refreshQuestion(old);
	assert.equal(contexts.length, 2);
	assert.match(feedback(1), /Put the correct option at correctIndex 3/);
	assert.deepEqual(rewritten, { ...atThree, rules: QUESTION_RULES });
	assert.match(JSON.stringify(contexts[0]!.messages), /Put the correct option at correctIndex 3/);
});

it("asks the model to condense long answers and retries until the options are short", async () => {
	const wordy = { ...shortQuestion(), options: [longBack, ...shortQuestion().options.slice(1)] };
	respond([submit("submit_question", wordy), submit("submit_question", shortQuestion())]);
	assert.deepEqual(await questionFor(longCard("long-retry")), { ...shortQuestion(), rules: QUESTION_RULES });
	assert.match(JSON.stringify(contexts[0]!.messages), /states the whole problem/);
	assert.match(JSON.stringify(contexts[0]!.messages), /only what differs between them/);
	assert.match(feedback(1), /Keep every option under 120 characters/);
});
