/**
 * THE INCREMENTAL PROJECTOR (src/core/view-incremental.ts): at every step of
 * a scripted turn — streaming text, a tool call then its result, a question
 * and its answer, an answer that lands on a quiz turns back, a plan block,
 * a send_to_user failure, the practice pose/conclude pair, compaction, a
 * record swap — the cached projection deep-equals the full projectView.
 * It must also never mutate a list it returned earlier (React holds those),
 * and a streaming update must leave every settled row the SAME object.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";
import { projectView, type LhViewMessage, type LiveExecution, type LiveTurnState } from "../src/core/view.ts";
import { createViewProjector } from "../src/core/view-incremental.ts";

type Block = object;
const usage = { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 };
const user = (id: string, text: string) => ({ id, role: "user", content: text, timestamp: 0 }) as unknown as LhMessage;
const assistant = (id: string, content: Block[], stopReason = "stop") =>
	({ id, role: "assistant", content, stopReason, usage, provider: "test", model: "test", timestamp: 0 }) as unknown as LhMessage;
const text = (t: string): Block => ({ type: "text", text: t });
const think = (t: string): Block => ({ type: "thinking", thinking: t });
const call = (id: string, name: string, args: unknown): Block => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, toolCallId: string, toolName: string, details: unknown, isError = false) =>
	({
		id,
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: isError ? `${toolName} failed` : "ok" }],
		details,
		isError,
		timestamp: 0,
	}) as unknown as LhMessage;
const marker = (id: string, customType: string, details: unknown, content = "") =>
	({ id, role: "custom", customType, content, display: true, details, timestamp: 0 }) as unknown as LhMessage;
const quizInput = (q: string) => ({ question: q, options: [{ label: "a" }, { label: "b" }], correctAnswer: "a" });
const answer = (q: string) => ({ kind: "quiz", question: q, selected: [0], correct: true });

/** A long, varied settled history (~`groups` × 9 messages). Every group has
 *  prose, reasoning, tools with results, an output call, a quiz; some
 *  quizzes stay open for a later answer, some groups carry a plan block,
 *  failures, steer cards, and the practice pose/conclude pair. */
function history(groups: number): LhMessage[] {
	const out: LhMessage[] = [marker("gc", "graph-context", { nodes: [] })];
	for (let g = 0; g < groups; g++) {
		out.push(user(`u${g}`, `question ${g}`));
		out.push(assistant(`a${g}`, [text(`answer ${g}`), think(`thinking ${g}`), call(`r${g}`, "read", { path: `f${g}` }), call(`s${g}`, "send_to_user", { message: `said ${g}` })]));
		out.push(result(`rr${g}`, `r${g}`, "read", { body: g }));
		out.push(result(`sr${g}`, `s${g}`, "send_to_user", null, g % 7 === 3));
		out.push(assistant(`b${g}`, [text(`more ${g}`), call(`q${g}`, "quiz", quizInput(`q${g}`))]));
		if (g % 4 !== 1) out.push(result(`qr${g}`, `q${g}`, "quiz", answer(`q${g}`)));
		if (g % 10 === 2) {
			out.push(assistant(`p${g}`, [call(`pi${g}`, "plan_init", {})]));
			out.push(result(`pir${g}`, `pi${g}`, "plan_init", { ok: true }));
			out.push(marker(`pb${g}`, "plan-block", { planCallId: `pi${g}`, block: { nodes: [g] } }));
		}
		if (g % 10 === 5) out.push(marker(`st${g}`, "subagent-steer", { kind: "research", result: { g } }, `steer ${g}`));
		if (g % 10 === 7) {
			out.push(assistant(`pp${g}`, [call(`pose${g}`, "problem", { statement: `s${g}`, modelSolution: `sol${g}` })]));
			out.push(result(`ppr${g}`, `pose${g}`, "problem", null));
			out.push(marker(`th${g}`, "practice-thinking", { problemCallId: `pose${g}`, text: "try" }));
			out.push(assistant(`cc${g}`, [call(`conc${g}`, "conclude", { outcome: "solved" })]));
			out.push(result(`ccr${g}`, `conc${g}`, "conclude", null));
		}
		if (g === Math.floor(groups / 2)) {
			out.push(marker("cmp1", "compaction", { firstKeptMessageId: `u${Math.floor(groups / 4)}`, tokensBefore: 1, at: "t" }, "summary"));
		}
	}
	return out;
}

const live = (streaming: string[], executions: [string, LiveExecution][] = []): LiveTurnState => ({
	inFlight: true,
	streamingIds: new Set(streaming),
	executions: new Map(executions),
});

/** Projects every step both ways; checks equality, non-mutation of the
 *  previous result, and (optionally) that settled rows kept identity. */
function harness() {
	const projector = createViewProjector();
	let previous: { out: LhViewMessage[]; frozen: string } | null = null;
	let steps = 0;
	return {
		get steps() {
			return steps;
		},
		step(messages: LhMessage[], l: LiveTurnState | undefined, label: string): LhViewMessage[] {
			const before = previous;
			const got = projector.project(messages, l);
			assert.deepStrictEqual(got, projectView(messages, l), `step ${steps} (${label}) differs from projectView`);
			if (before) assert.equal(JSON.stringify(before.out), before.frozen, `step ${steps} (${label}) mutated the previous result`);
			previous = { out: got, frozen: JSON.stringify(got) };
			steps++;
			return got;
		},
	};
}

describe("incremental projection equals projectView", () => {
	it("through a scripted turn sequence on a long history", () => {
		const h = harness();
		const base = history(60);
		let tail: LhMessage[] = [];
		const record = () => [...base, ...tail];
		let view = h.step(record(), undefined, "settled");
		// An unanswered quiz from far back (g % 4 === 1) for the late answer.
		assert.ok(base.some((m) => m.id === "u1"));

		// 1. Send: optimistic user bubble, then the reply streams in.
		tail = [user("c_1", "teach me")];
		view = h.step(record(), live([]), "optimistic user");
		tail = [...tail, assistant("s1", [])];
		view = h.step(record(), live(["s1"]), "message_start (empty → thinking row)");
		let reply = "";
		for (let i = 0; i < 12; i++) {
			const prev = view;
			reply += ` word${i}`;
			tail = tail.with(-1, assistant("s1", [think("hmm"), text(reply)]));
			view = h.step(record(), live(["s1"]), `stream text ${i}`);
			// Settled rows are the same objects: only the streaming row changed.
			assert.equal(view.length, prev.length);
			for (let r = 0; r < view.length - 1; r++) assert.equal(view[r], prev[r], `row ${r} re-created on a streaming update`);
		}

		// 2. A tool call streams, executes, then its result lands.
		tail = tail.with(-1, assistant("s1", [think("hmm"), text(reply), call("t1", "read", { pa: 1 })]));
		h.step(record(), live(["s1"]), "tool call input-streaming");
		tail = tail.with(-1, assistant("s1", [think("hmm"), text(reply), call("t1", "read", { path: "x" })]));
		h.step(record(), live(["s1"]), "message_end");
		const ex1: [string, LiveExecution] = ["t1", { isError: false, output: { body: "x" } }];
		h.step(record(), live(["s1"], [ex1]), "tool_execution_end");
		tail = [...tail, result("c_r1", "t1", "read", { body: "x" })];
		h.step(record(), live(["s1"], [ex1]), "turn_end results");
		// The next step merges into the same assistant group.
		tail = [...tail, assistant("s2", [])];
		h.step(record(), live(["s1", "s2"], [ex1]), "step 2 start");
		for (let i = 0; i < 4; i++) {
			tail = tail.with(-1, assistant("s2", [text(`step two ${i}`)]));
			h.step(record(), live(["s1", "s2"], [ex1]), `step 2 text ${i}`);
		}

		// 3. A question: the quiz call, its clean placeholder, the dock.
		tail = tail.with(-1, assistant("s2", [text("step two"), call("qz", "quiz", quizInput("live"))]));
		h.step(record(), live(["s1", "s2"], [ex1]), "quiz streaming");
		const exq: [string, LiveExecution] = ["qz", { isError: false, output: { text: "Question posed" } }];
		h.step(record(), live(["s1", "s2"], [ex1, exq]), "quiz executed");
		tail = [...tail, result("c_rq", "qz", "quiz", null)];
		h.step(record(), live(["s1", "s2"], [ex1, exq]), "quiz placeholder result");
		h.step(record(), undefined, "turn settled");
		// The learner answers (optimistic result) — then a turns-old quiz.
		tail = [...tail, result("c_ans", "qz", "quiz", answer("live"))];
		h.step(record(), live([]), "answer lands");
		tail = [...tail, result("c_old", "q1", "quiz", answer("q1"))];
		h.step(record(), live([]), "late answer to a quiz 60 groups back");
		// A settled message can never stream again in practice; exactness anyway.
		h.step(record(), live(["b5"]), "an old message's open quiz flagged streaming");
		h.step(record(), live([]), "and unflagged");

		// 4. A plan block splices into the preceding group.
		tail = [...tail, assistant("s3", []), ];
		h.step(record(), live(["s3"]), "plan step start");
		tail = tail.with(-1, assistant("s3", [call("pin", "plan_init", {})]));
		h.step(record(), live(["s3"]), "plan_init streaming");
		tail = [...tail, result("c_pin", "pin", "plan_init", { ok: true })];
		h.step(record(), live(["s3"], [["pin", { isError: false, output: { ok: true } }]]), "plan_init ok");
		tail = [...tail, marker("pb_live", "plan-block", { planCallId: "pin", block: { nodes: ["live"] } })];
		h.step(record(), live(["s3"], [["pin", { isError: false, output: { ok: true } }]]), "plan block marker");

		// 5. A send_to_user failure arriving for an output call in the prefix.
		tail = [...tail, assistant("s4", [call("out1", "send_to_user", { message: "hello" })])];
		h.step(record(), live(["s4"]), "output call");
		tail = [...tail, user("c_2", "next")];
		h.step(record(), live(["s4"]), "user after output");
		tail = [...tail, result("c_oe", "out1", "send_to_user", null, true)];
		h.step(record(), live(["s4"]), "output failure reaches back");

		// 6. Practice: a conclude in the prefix, then its problem acked later.
		tail = [...tail, assistant("s5", [call("pose", "problem", { modelSolution: "S" })]), assistant("s6", [call("conc", "conclude", {})])];
		h.step(record(), live(["s5", "s6"]), "pose + conclude before the ack");
		tail = [...tail, user("c_4", "go on")];
		h.step(record(), live(["s5", "s6"]), "the conclude settles into the prefix");
		tail = [...tail, result("c_ack", "pose", "problem", null)];
		h.step(record(), live(["s5", "s6"]), "late clean pose ack changes the reveal");
		tail = [...tail, user("c_5", "and then")];
		h.step(record(), live(["s5", "s6"]), "a checkpoint past the ack");
		tail = [...tail, user("c_6", "settle")];
		h.step(record(), undefined, "settled");

		// 7. Compaction: a new active marker moves the cut divider.
		tail = [...tail, marker("cmp2", "compaction", { firstKeptMessageId: "u40", tokensBefore: 2, at: "t2" }, "summary 2")];
		h.step(record(), undefined, "compaction marker");
		tail = [...tail, user("c_3", "after compaction"), assistant("s7", [])];
		for (let i = 0; i < 3; i++) {
			tail = tail.with(-1, assistant("s7", [text(`post ${i}`)]));
			h.step(record(), live(["s7"]), `post-compaction stream ${i}`);
		}

		// 8. The settle sync swaps in fresh copies; an optimistic entry dies.
		const synced = structuredClone(record());
		h.step(synced, undefined, "record swap (new identities)");
		h.step(synced.slice(0, -1), undefined, "tail shrinks");
		const rewritten = synced.map((m) => (m.id === "a30" && m.role === "assistant" ? assistant("a30", [text("rewritten")]) : m));
		h.step(rewritten, undefined, "an old message rewritten under the tail");
		h.step(synced, undefined, "tail regrows");
		h.step([], undefined, "empty");
		h.step(synced, live(["s7"]), "live again");
		assert.ok(h.steps > 40, `${h.steps} steps`);
	});

	it("keeps the cache intact when one update lands a settled message and a streaming one that merges into it", () => {
		const h = harness();
		const base = history(8);
		h.step(base, undefined, "settled");
		const prefix = [...base, user("c_u", "hi"), assistant("x1", [text("settled step")])];
		let view = h.step([...prefix, assistant("x2", [])], live(["x2"]), "two arrive at once");
		for (let i = 0; i < 3; i++) {
			const prev = view;
			view = h.step([...prefix, assistant("x2", [text(`streamed ${i}`)])], live(["x2"]), `stream ${i}`);
			for (let r = 0; r < view.length - 1; r++) assert.equal(view[r], prev[r], `row ${r} re-created`);
		}
	});

	it("matches projectView under random appends, replacements, removals and live changes", () => {
		for (const seed of [1, 2, 3, 4, 5, 6]) {
			let s = seed;
			const rand = (n: number) => {
				s = (s * 1103515245 + 12345) % 2147483648;
				return s % n;
			};
			const pool = history(12);
			const h = harness();
			let messages: LhMessage[] = pool.slice(0, 20);
			let next = 20;
			let streaming: string[] = [];
			let executions: [string, LiveExecution][] = [];
			const callIds = pool.flatMap((m) =>
				m.role === "assistant" ? m.content.flatMap((b) => (b.type === "toolCall" ? [b.id] : [])) : [],
			);
			for (let i = 0; i < 400; i++) {
				const op = rand(10);
				if (op < 3 && next < pool.length) {
					messages = [...messages, pool[next++]!];
				} else if (op < 6 && messages.length) {
					// Replace the last message with a grown copy (a stream update).
					const last = messages.at(-1)!;
					const grown =
						last.role === "assistant"
							? assistant(last.id, [...last.content, text(`grow ${i}`)], last.stopReason)
							: { ...last };
					messages = messages.with(-1, grown as LhMessage);
				} else if (op === 6 && messages.length) {
					messages = messages.slice(0, -1);
				} else if (op === 7) {
					// Usually the last message streams; sometimes any message
					// (an exactness probe for the live layer's prefix rule).
					const pick = rand(3) ? messages.at(-1) : messages[rand(Math.max(1, messages.length))];
					streaming = pick && rand(2) ? [pick.id] : [];
				} else if (op === 8) {
					const id = callIds[rand(callIds.length)]!;
					executions = rand(3) ? [...executions, [id, { isError: rand(4) === 0, output: { i }, errorText: "bad" }]] : [];
				} else if (op === 9 && messages.length) {
					if (rand(4) === 0) messages = structuredClone(messages);
					else {
						// An earlier message changes (a record rewrite under the tail).
						const at = rand(messages.length);
						const old = messages[at]!;
						const changed = old.role === "assistant" ? assistant(old.id, [text(`rewritten ${i}`), ...old.content], old.stopReason) : { ...old };
						messages = messages.with(at, changed as LhMessage);
					}
				}
				const l = rand(3) === 0 ? undefined : live(streaming, executions);
				h.step(messages, l, `seed ${seed} op ${i}`);
			}
		}
	});
});
