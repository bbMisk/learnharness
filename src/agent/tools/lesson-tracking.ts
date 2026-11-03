import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { ChatStore } from "../../core/ports.ts";
import {
	correctProblemCount,
	lessonTrackerOf,
	NOTE_MISTAKE_TOOL,
	PROBLEM_DONE_TOOL,
	PROBLEM_LIST_TOOL,
	PROBLEM_OUTCOMES,
	PROBLEM_START_TOOL,
	RESOLVE_MISTAKE_TOOL,
	type LessonTracker,
	type NoteMistakeDetails,
	type ProblemDoneDetails,
	type ProblemListDetails,
	type ProblemOutcome,
	type ProblemStartDetails,
	type ResolveMistakeDetails,
} from "../../core/lesson-tracking.ts";

/**
 * The lesson-tracking tools (owner, 2026-11-02 — core/lesson-tracking.ts):
 * the cram teacher's problem set (problem_list / problem_start /
 * problem_done) and every
 * teacher's mistake log (note_mistake / resolve_mistake). SERVER-SIDE,
 * persisted in the transcript like plan_init: the state is DERIVED from
 * the record's successful results (their `details`), never stored apart.
 *
 * Validation reads the derived state. A turn persists its messages only at
 * its end, so the registry (built per request) seeds ONE tracker from the
 * record at its first tracking call and folds its own successes into it
 * with the same reducer — a second note_mistake in the same turn mints m2,
 * a problem_done sees a list written earlier in the turn. The tracker is
 * keyed to the tool CONTEXT object, so the mid-run registry rebuild (the
 * live question-type swap, teacher-agent.ts — same ctx) keeps it.
 *
 * CONTEXT-SLIM results (the plan_init pattern): content is a short JSON
 * ack — the model wrote the input one message ago — and failures carry
 * only the error; details carry the fold's data (agent-invisible).
 */

export interface LessonTrackingToolContext {
	chatId: string;
	/** The record the tracker seeds from. */
	chatStore: ChatStore;
}

const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_ID = 40;
const MAX_LABEL = 80;
const MAX_MISTAKE = 200;

const problemListInput = Type.Object({
	problems: Type.Array(
		Type.Object({
			id: Type.String({ description: "Permanent lowercase slug (a-z, 0-9, hyphens/underscores), e.g. q3." }),
			label: Type.String({ description: "Short single-line label, e.g. 'Q3: CRLB bound'." }),
		}),
		{ description: "Every problem in the set, in order." },
	),
});
const problemStartInput = Type.Object({
	id: Type.String({ description: "The problem's id from the latest problem_list." }),
});
const problemDoneInput = Type.Object({
	id: Type.String({ description: "The problem's id from the latest problem_list." }),
	outcome: Type.Union(PROBLEM_OUTCOMES.map((o) => Type.Literal(o)), {
		description: "correct: the learner completed its full attempt correctly (after any follow-up); incorrect: they didn't; skipped: you moved on without an attempt.",
	}),
});
const noteMistakeInput = Type.Object({
	text: Type.String({ description: "One short line naming the mistake." }),
});
const resolveMistakeInput = Type.Object({
	id: Type.String({ description: "The id note_mistake returned (m1, m2, …)." }),
});

/** Problems with a problem_list input (empty = valid). */
export function problemListProblems(problems: ReadonlyArray<{ id: unknown; label: unknown }>): string[] {
	const out: string[] = [];
	if (problems.length === 0) out.push("problems is empty — list every problem in the set.");
	const seen = new Set<string>();
	problems.forEach((p, i) => {
		const at = `problems[${i}]`;
		if (typeof p.id !== "string" || !SLUG.test(p.id) || p.id.length > MAX_ID) {
			out.push(`${at}.id "${String(p.id)}" is not a slug — use lowercase a-z, 0-9, hyphens/underscores (at most ${MAX_ID} characters), e.g. q3.`);
		} else if (seen.has(p.id)) {
			out.push(`${at}.id "${p.id}" is a duplicate — ids must be unique.`);
		} else seen.add(p.id);
		const label = typeof p.label === "string" ? p.label.trim() : "";
		if (!label) out.push(`${at}.label is empty — give a short label, e.g. 'Q3: CRLB bound'.`);
		else if (label.length > MAX_LABEL || /[\r\n]/.test(label)) {
			out.push(`${at}.label is too long — one short line (at most ${MAX_LABEL} characters).`);
		}
	});
	return out;
}

function listIds(ids: readonly string[]): string {
	return ids.length > 8 ? `${ids.slice(0, 8).join(", ")}, …` : ids.join(", ");
}

/** One lazily-seeded tracker per tool context (see the module note). */
const trackers = new WeakMap<LessonTrackingToolContext, LessonTracker>();

/**
 * The tracking tools for one teacher registry: the mistake pair always,
 * the problem tools only for a cram teacher (`problems`). All share one
 * lazily-seeded tracker per context (see the module note).
 */
export function lessonTrackingTools(
	ctx: LessonTrackingToolContext,
	opts: { problems: boolean },
): Record<string, AgentTool<any>> {
	const tracker = (): LessonTracker => {
		let t = trackers.get(ctx);
		if (!t) {
			t = lessonTrackerOf(ctx.chatStore.getChat(ctx.chatId)?.messages ?? []);
			trackers.set(ctx, t);
		}
		return t;
	};
	/** The latest list's validation for a problem id, or null when valid. */
	const unknownProblem = (t: LessonTracker, id: string): string | null => {
		const ids = t.problemIds();
		if (ids === null) return "No problem list yet — call problem_list first.";
		return ids.includes(id) ? null : `No problem "${id}" in the current list. Ids: ${listIds(ids)}.`;
	};

	const mistakeTools: Record<string, AgentTool<any>> = {
		[NOTE_MISTAKE_TOOL]: {
			name: NOTE_MISTAKE_TOOL,
			label: NOTE_MISTAKE_TOOL,
			description:
				"Log a substantive mistake the learner made (a misconception or a wrong step, not a slip or typo) as one short line naming it. " +
				"Returns its id (m1, m2, …) for resolve_mistake.",
			parameters: noteMistakeInput,
			execute: serverExecute(NOTE_MISTAKE_TOOL, noteMistakeInput, ({ text }) => {
				const line = text.trim();
				if (!line) return { ok: false, error: "text is empty — name the mistake in one short line." };
				if (line.length > MAX_MISTAKE || /[\r\n]/.test(line)) {
					return { ok: false, error: `text is too long — one short line (at most ${MAX_MISTAKE} characters).` };
				}
				const t = tracker();
				const details: NoteMistakeDetails = { ok: true, id: t.nextMistakeId(), text: line };
				t.apply(NOTE_MISTAKE_TOOL, details);
				return { text: JSON.stringify({ ok: true, id: details.id }), details };
			}),
		},
		[RESOLVE_MISTAKE_TOOL]: {
			name: RESOLVE_MISTAKE_TOOL,
			label: RESOLVE_MISTAKE_TOOL,
			description:
				"Mark a noted mistake resolved, by the id note_mistake returned — once the learner gets right a problem or check that would have exposed it.",
			parameters: resolveMistakeInput,
			execute: serverExecute(RESOLVE_MISTAKE_TOOL, resolveMistakeInput, ({ id }) => {
				const t = tracker();
				const mistake = t.mistake(id);
				const open = t.snapshot().mistakes.filter((m) => !m.resolved).map((m) => m.id);
				const openText = open.length > 0 ? `Open mistakes: ${listIds(open)}.` : "No mistakes are open.";
				if (!mistake) return { ok: false, error: `No mistake "${id}". ${openText}` };
				if (mistake.resolved) return { ok: false, error: `Mistake "${id}" is already resolved. ${openText}` };
				const details: ResolveMistakeDetails = { ok: true, id };
				t.apply(RESOLVE_MISTAKE_TOOL, details);
				return { text: JSON.stringify({ ok: true }), details };
			}),
		},
	};
	if (!opts.problems) return mistakeTools;

	return {
		[PROBLEM_LIST_TOOL]: {
			name: PROBLEM_LIST_TOOL,
			label: PROBLEM_LIST_TOOL,
			description:
				"Set the problem set, in order: each problem gets a permanent slug id and a short label (e.g. 'Q3: CRLB bound'). " +
				"Replaces the whole list; re-call only if the set itself changes.",
			parameters: problemListInput,
			execute: serverExecute(PROBLEM_LIST_TOOL, problemListInput, ({ problems }) => {
				const issues = problemListProblems(problems);
				if (issues.length > 0) return { ok: false, error: issues.join("\n") };
				const details: ProblemListDetails = {
					ok: true,
					problems: problems.map((p) => ({ id: p.id, label: p.label.trim() })),
				};
				tracker().apply(PROBLEM_LIST_TOOL, details);
				return { text: JSON.stringify({ ok: true, problems: details.problems.length }), details };
			}),
		},
		[PROBLEM_START_TOOL]: {
			name: PROBLEM_START_TOOL,
			label: PROBLEM_START_TOOL,
			description: "Mark a problem from the latest problem_list as begun, by id — call it when you begin the problem.",
			parameters: problemStartInput,
			execute: serverExecute(PROBLEM_START_TOOL, problemStartInput, ({ id }) => {
				const t = tracker();
				const error = unknownProblem(t, id);
				if (error) return { ok: false, error };
				const details: ProblemStartDetails = { ok: true, id };
				t.apply(PROBLEM_START_TOOL, details);
				return { text: JSON.stringify({ ok: true }), details };
			}),
		},
		[PROBLEM_DONE_TOOL]: {
			name: PROBLEM_DONE_TOOL,
			label: PROBLEM_DONE_TOOL,
			description:
				"Record how you left a problem from the latest problem_list, by id: outcome correct, incorrect or skipped. A later call replaces the problem's earlier outcome.",
			parameters: problemDoneInput,
			execute: serverExecute(PROBLEM_DONE_TOOL, problemDoneInput, ({ id, outcome }) => {
				const t = tracker();
				const error = unknownProblem(t, id);
				if (error) return { ok: false, error };
				if (!PROBLEM_OUTCOMES.includes(outcome as ProblemOutcome)) {
					return { ok: false, error: `outcome "${String(outcome)}" is not one of: ${PROBLEM_OUTCOMES.join(", ")}.` };
				}
				const details: ProblemDoneDetails = { ok: true, id, outcome: outcome as ProblemOutcome };
				t.apply(PROBLEM_DONE_TOOL, details);
				const problems = t.snapshot().problems ?? [];
				return {
					text: JSON.stringify({ ok: true, correct: correctProblemCount(problems), of: problems.length }),
					details,
				};
			}),
		},
		...mistakeTools,
	};
}
