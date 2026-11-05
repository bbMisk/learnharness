/**
 * Plan progress (owner, 2026-11-05 — src/core/plan-progress.ts): the
 * Progress card's Plan section. Pins the statuses (the plan map's own
 * derivation), the covered count, the per-step check scores and their
 * colour verdict, the plan order, and the lesson gate (no plan, cram,
 * practice). Pure; one case runs through the real native → view projection
 * so the placeholder and the answer arrive the way the chat sees them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlanTree } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { derivePlanProgress, lessonPlanProgress, planCheckVerdict, planStepOrder, type PlanProgressMessage } from "../src/core/plan-progress.ts";
import { projectView } from "../src/core/view.ts";

const tree = (ids: string[], edges: Array<[string, string]> = [], version = 1): PlanTree => ({
	nodes: ids.map((id) => ({ id, title: id.toUpperCase() })),
	edges: edges.map(([from, to]) => ({ from, to })),
	version,
});

const ABC = tree(["a", "b", "c"], [["a", "b"], ["b", "c"]]);

type Part = PlanProgressMessage["parts"][number];
const right = { kind: "quiz", dontKnow: false, correct: true, answers: [], questionText: "q", answeredAt: "t" };
const wrong = { ...right, correct: false };
const dontKnow = { ...right, dontKnow: true, correct: false };
const dismissed = { ...right, dismissed: true, correct: false };
const explained = { kind: "explain", dontKnow: false, answers: [], text: "because", questionText: "q", answeredAt: "t" };

/** A tagged check: answered (output-available) when `answer` is given, else
 *  a pending call (input-available — the view's state for an unanswered
 *  question, including one whose placeholder ack landed). */
const check = (nodeId: string | undefined, answer?: unknown, tool = "quiz"): Part =>
	answer === undefined
		? { type: `tool-${tool}`, state: "input-available", input: nodeId === undefined ? {} : { nodeId } }
		: { type: `tool-${tool}`, state: "output-available", input: nodeId === undefined ? {} : { nodeId }, output: answer };
const msg = (...parts: Part[]): PlanProgressMessage => ({ parts });

const view = (p: ReturnType<typeof derivePlanProgress>) => p.steps.map((s) => [s.id, s.status, `${s.right}/${s.answered}`, s.latest]);

describe("derivePlanProgress", () => {
	it("before any tagged check: everything upcoming, nothing covered, no scores", () => {
		const p = derivePlanProgress(ABC, []);
		assert.equal(p.covered, 0);
		assert.equal(p.total, 3);
		assert.deepEqual(view(p), [
			["a", "upcoming", "0/0", null],
			["b", "upcoming", "0/0", null],
			["c", "upcoming", "0/0", null],
		]);
		assert.deepEqual(p.steps.map((s) => s.title), ["A", "B", "C"]);
	});

	it("statuses: current = the latest tagged call's node, covered = earlier ones; the current one is not counted", () => {
		const p = derivePlanProgress(ABC, [msg(check("a", right), check("a", wrong)), msg(check("b"))]);
		assert.deepEqual(view(p).map((r) => r.slice(0, 2)), [["a", "visited"], ["b", "current"], ["c", "upcoming"]]);
		assert.equal(p.covered, 1, "a is covered; b (current) is not");
		// A pending (unanswered) call still moves position — calls, not results.
		assert.equal(p.steps[1]!.answered, 0, "but scores nothing");
	});

	it("scores: right/answered per node, the colour from the LATEST answer", () => {
		const p = derivePlanProgress(ABC, [msg(check("a", wrong), check("a", right)), msg(check("b", right), check("b", wrong))]);
		assert.deepEqual(view(p), [
			["a", "visited", "1/2", "right"],
			["b", "current", "1/2", "wrong"],
			["c", "upcoming", "0/0", null],
		]);
	});

	it("I don't know is answered and not right; a dismissal and a placeholder are not answers", () => {
		const p = derivePlanProgress(ABC, [
			msg(check("a", right), check("a", dontKnow)),
			msg(check("b", right), check("b", dismissed)),
			// The view never gives a placeholder an output; a null output (defence) is no answer either.
			msg(check("c", right), check("c"), { type: "tool-quiz", state: "output-available", input: { nodeId: "c" }, output: null }),
		]);
		assert.deepEqual(view(p), [
			["a", "visited", "1/2", "wrong"],
			["b", "visited", "1/1", "right"],
			["c", "current", "1/1", "right"],
		]);
	});

	it("a failed call, an untagged check, a nodeId outside the tree and other tools are ignored", () => {
		const p = derivePlanProgress(ABC, [
			msg(
				check("a", right),
				{ type: "tool-quiz", state: "output-error", input: { nodeId: "a" } },
				check(undefined, wrong),
				check("zzz", wrong),
				{ type: "tool-probe", state: "output-available", input: { nodeId: "a" }, output: wrong },
				{ type: "tool-ask", state: "output-available", input: { nodeId: "a" }, output: wrong },
			),
		]);
		assert.deepEqual(view(p), [
			["a", "current", "1/1", "right"],
			["b", "upcoming", "0/0", null],
			["c", "upcoming", "0/0", null],
		]);
	});

	it("an ungraded (explain) answer counts for nothing; graded ones and \"I don't know\" still count", () => {
		const p = derivePlanProgress(ABC, [msg(check("a", right, "explain"), check("a", explained, "explain")), msg(check("b", explained, "explain"), check("b", dontKnow, "explain"))]);
		assert.deepEqual(view(p), [
			["a", "visited", "1/1", "right"],
			["b", "current", "0/1", "wrong"],
			["c", "upcoming", "0/0", null],
		]);
	});

	it("a revisit a→b→a: a is current again (not covered), b covered; a's scores span both stays", () => {
		const p = derivePlanProgress(ABC, [msg(check("a", right)), msg(check("b", wrong)), msg(check("a", wrong))]);
		assert.deepEqual(view(p), [
			["a", "current", "1/2", "wrong"],
			["b", "visited", "0/1", "wrong"],
			["c", "upcoming", "0/0", null],
		]);
		assert.equal(p.covered, 1);
	});

	it("a plan rewrite that drops a node: its checks fall away, kept ids keep theirs, new nodes join upcoming", () => {
		const record = [msg(check("a", right)), msg(check("b", right), check("b", wrong))];
		assert.equal(derivePlanProgress(ABC, record).steps[1]!.answered, 2);
		const rewritten = tree(["a", "c", "d"], [["a", "c"], ["c", "d"]], 2);
		const p = derivePlanProgress(rewritten, record);
		assert.deepEqual(view(p), [
			["a", "current", "1/1", "right"],
			["c", "upcoming", "0/0", null],
			["d", "upcoming", "0/0", null],
		]);
		assert.equal(p.covered, 0, "b's stay no longer counts; a is current again");
		assert.equal(p.total, 3);
	});
});

describe("planStepOrder", () => {
	it("keeps the tree's order when it is already topological", () => {
		const t = tree(["a", "b", "c", "d"], [["a", "c"], ["b", "c"], ["c", "d"]]);
		assert.deepEqual(planStepOrder(t).map((n) => n.id), ["a", "b", "c", "d"]);
	});

	it("puts a prerequisite before its dependent when the mermaid named the dependent first", () => {
		// `b --> c` then `a --> b`: first-mention order is b, c, a.
		const t = tree(["b", "c", "a", "x"], [["b", "c"], ["a", "b"]]);
		assert.deepEqual(planStepOrder(t).map((n) => n.id), ["a", "b", "c", "x"]);
		assert.deepEqual(derivePlanProgress(t, []).steps.map((s) => s.id), ["a", "b", "c", "x"], "the section reads in that order");
	});

});

describe("planCheckVerdict", () => {
	it("maps an answer to right / wrong, or null for a non-answer or an ungraded one", () => {
		assert.equal(planCheckVerdict(right), "right");
		assert.equal(planCheckVerdict(wrong), "wrong");
		assert.equal(planCheckVerdict(dontKnow), "wrong");
		assert.equal(planCheckVerdict({ ...dontKnow, correct: undefined }), "wrong", "I don't know without a grade");
		assert.equal(planCheckVerdict(explained), null, "ungraded");
		assert.equal(planCheckVerdict(dismissed), null);
		assert.equal(planCheckVerdict(null), null);
		assert.equal(planCheckVerdict(undefined), null);
	});
});

describe("lessonPlanProgress (the section's gate)", () => {
	const teach = { cram: false, practice: false };
	it("a teach lesson with a plan has the section", () => {
		assert.equal(lessonPlanProgress(ABC, [], teach)?.total, 3);
	});
	it("none without a plan, or with an empty one", () => {
		assert.equal(lessonPlanProgress(null, [], teach), null);
		assert.equal(lessonPlanProgress(tree([]), [], teach), null);
	});
	it("none in cram, none in practice", () => {
		assert.equal(lessonPlanProgress(ABC, [], { cram: true, practice: false }), null);
		assert.equal(lessonPlanProgress(ABC, [], { cram: false, practice: true }), null);
	});
});

describe("through the native → view projection", () => {
	const assistant = (id: string, calls: Array<{ id: string; name: string; nodeId: string }>): LhMessage =>
		({
			id,
			role: "assistant",
			content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: { nodeId: c.nodeId, question: "q" } })),
			api: "openai-completions",
			provider: "openrouter",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "toolUse",
			timestamp: 1,
		}) as never;
	const result = (callId: string, details: unknown): LhMessage =>
		({ id: `r_${callId}`, role: "toolResult", toolCallId: callId, toolName: "quiz", content: [{ type: "text", text: "Question posed" }], details, isError: false, timestamp: 2 }) as never;

	it("a placeholder ack scores nothing; the answer that lands scores and colours", () => {
		const posed = [assistant("m1", [{ id: "c1", name: "quiz", nodeId: "a" }]), result("c1", null)];
		let p = derivePlanProgress(ABC, projectView(posed));
		assert.deepEqual(view(p)[0], ["a", "current", "0/0", null], "posed: current, unscored");
		const answered = [assistant("m1", [{ id: "c1", name: "quiz", nodeId: "a" }]), result("c1", wrong)];
		p = derivePlanProgress(ABC, projectView(answered));
		assert.deepEqual(view(p)[0], ["a", "current", "0/1", "wrong"], "answered: scored live");
	});
});
