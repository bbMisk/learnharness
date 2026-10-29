import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";
import { mergeLearningEvents } from "../src/core/learning-history.ts";

const call = (id: string, name: string, args: Record<string, unknown>, timestamp = 1000): LhMessage => ({
	id: `m-${id}`, role: "assistant", timestamp,
	content: [{ type: "toolCall", id, name, arguments: args }],
} as LhMessage);
const result = (id: string, name: string, details: unknown, isError = false): LhMessage => ({
	id: `r-${id}`, role: "toolResult", toolCallId: id, toolName: name,
	content: [], details, isError, timestamp: 3000,
} as LhMessage);

describe("learning event capture", () => {
	it("keeps question and answer snapshots with source times and separate plan IDs", () => {
		const messages = [
			call("q1", "quiz", { question: "2 + 2?", nodeId: "plan-7", options: [{ label: "4" }], correctAnswer: "4" }),
			result("q1", "quiz", { kind: "quiz", questionText: "2 + 2?", correct: true, confidence: 90, thinking: "Two pairs", answeredAt: "client-clock" }),
		];
		const events = mergeLearningEvents(undefined, messages);
		assert.deepEqual(events.map(e => [e.kind, e.at, e.itemId]), [
			["question-posed", "1970-01-01T00:00:01.000Z", "q1"],
			["question-answered", "1970-01-01T00:00:03.000Z", "q1"],
		]);
		assert.equal(events[0]!.planNodeId, "plan-7");
		assert.deepEqual(events[0]!.graphNodeIds, []);
		assert.equal(events[1]!.outcome, "correct");
		assert.deepEqual(events[1]!.payload, (messages[1] as { details: unknown }).details);
		(messages[0]! as { content: { arguments: Record<string, unknown> }[] }).content[0]!.arguments.question = "Changed";
		assert.equal(events[0]!.payload.question, "2 + 2?");
	});

	it("deduplicates retries and keeps captured facts when messages are removed", () => {
		const messages = [call("q1", "recall", { question: "Explain" })];
		const first = mergeLearningEvents(undefined, messages);
		assert.equal(first.length, 1);
		assert.deepEqual(mergeLearningEvents(first, [...messages, ...messages]), first);
		assert.deepEqual(mergeLearningEvents(first, []), first);
	});

	it("distinguishes dismissal, don't-know, incorrect and ungraded responses", () => {
		const variants = [
			{ dismissed: true, correct: false }, { dontKnow: true, correct: false },
			{ correct: false }, { text: "Explanation" },
		];
		const events = mergeLearningEvents(undefined, variants.flatMap((details, i) => [
			call(`q${i}`, "quiz", { question: "Question" }), result(`q${i}`, "quiz", { kind: "quiz", questionText: "Question", ...details }),
		]));
		assert.deepEqual(events.filter(e => e.kind === "question-answered").map(e => e.outcome), ["dismissed", "dont-know", "incorrect", "ungraded"]);
	});

	it("does not count placeholder or interrupted tool results as answers", () => {
		const events = mergeLearningEvents(undefined, [
			call("q1", "quiz", { question: "Question" }), result("q1", "quiz", {}),
		]);
		assert.deepEqual(events.map(e => e.kind), ["question-posed"]);
	});

	it("records successful practice and explicit graph targets, without counting failed poses", () => {
		const messages = [
			call("bad", "problem", { statement: "Invalid", target: ["n_bad"] }), result("bad", "problem", {}, true),
			call("p1", "problem", { statement: "Prove it", target: ["n_real"], mode: "recall" }), result("p1", "problem", {}),
			{ id: "thinking-1", role: "custom", customType: "practice-thinking", content: "", display: true, details: { problemCallId: "p1", text: "A proof attempt" }, timestamp: 4000 } as LhMessage,
			call("c1", "conclude", { outcome: "solvedWithHints", rung: "R2" }, 5000),
			{ ...result("c1", "conclude", {}), timestamp: 6000 },
		];
		const events = mergeLearningEvents(undefined, messages);
		assert.deepEqual(events.map(e => e.kind), ["practice-posed", "practice-thinking", "practice-concluded"]);
		assert.ok(events.every(e => e.itemId === "p1"));
		assert.ok(events.every(e => JSON.stringify(e.graphNodeIds) === '["n_real"]'));
		assert.equal(events[2]!.outcome, "solvedWithHints");
		assert.equal(events[2]!.payload.rung, "R2");
	});

	it("keeps missing times unknown and does not interpret imported graph context as practice", () => {
		const events = mergeLearningEvents(undefined, [
			{ ...call("q1", "probe", { question: "Question" }), timestamp: NaN },
			{ id: "context", role: "custom", customType: "graph-context", details: { propositions: [{ id: "n_read" }] }, timestamp: 1000 } as LhMessage,
		]);
		assert.equal(events.length, 1);
		assert.equal(events[0]!.at, null);
		assert.deepEqual(events[0]!.graphNodeIds, []);
	});

	it("retains a practice target when the original pose has left the compacted transcript", () => {
		const previous = mergeLearningEvents(undefined, [
			call("p1", "problem", { statement: "Prove it", target: ["n_real"] }), result("p1", "problem", {}),
		]);
		const events = mergeLearningEvents(previous, [
			{ id: "thinking-after-compaction", role: "custom", customType: "practice-thinking", details: { problemCallId: "p1", text: "The next step" }, timestamp: 4000 } as LhMessage,
			call("c1", "conclude", { outcome: "solved" }, 5000), result("c1", "conclude", {}),
		]);
		assert.deepEqual(events.map(e => [e.kind, e.graphNodeIds]), [
			["practice-posed", ["n_real"]], ["practice-thinking", ["n_real"]], ["practice-concluded", ["n_real"]],
		]);
	});
});
