import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { ChatStore } from "../../core/ports.ts";
import {
	lessonTrackerOf,
	NOTE_MISTAKE_TOOL,
	PROBLEM_DONE_TOOL,
	PROBLEM_LIST_TOOL,
	PROBLEM_OUTCOMES,
	PROBLEM_START_TOOL,
	RESOLVE_MISTAKE_TOOL,
	type LessonTracker,
	type TrackingCommandResult,
} from "../../core/lesson-tracking.ts";

/**
 * The lesson-tracking tools (owner, 2026-11-02 — core/lesson-tracking.ts):
 * the cram teacher's problem set (problem_list / problem_start /
 * problem_done) and every
 * teacher's mistake log (note_mistake / resolve_mistake). SERVER-SIDE,
 * persisted in the transcript like plan_init: the state is DERIVED from
 * the record's successful results (their `details`), never stored apart.
 *
 * Validation, id minting and sequencing are the tracker's strict commands
 * (core/lesson-tracking.ts). A turn persists its messages only at its end,
 * so the registry (built per request) seeds ONE tracker from the record at
 * its first tracking call and runs every command against it — a second
 * note_mistake in the same turn mints m2,
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
	/** Called after each logged mistake (the composition root writes its
	 *  flashcard — server/mistake-cards.ts); fire-and-forget. */
	onMistake?: (mistake: { id: string; text: string }) => void;
}

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

/** A command's outcome as the tool's result: the error as-is, or the JSON
 *  ack for the model with the details for the record. */
function reply<D>(result: TrackingCommandResult<D>): { ok: false; error: string } | { text: string; details: D } {
	return result.ok ? { text: JSON.stringify(result.ack), details: result.details } : result;
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
	const mistakeTools: Record<string, AgentTool<any>> = {
		[NOTE_MISTAKE_TOOL]: {
			name: NOTE_MISTAKE_TOOL,
			label: NOTE_MISTAKE_TOOL,
			description:
				"Log a substantive mistake the learner made (a misconception or a wrong step, not a slip or typo) as one short line naming it. " +
				"Returns its id (m1, m2, …) for resolve_mistake.",
			parameters: noteMistakeInput,
			execute: serverExecute(NOTE_MISTAKE_TOOL, noteMistakeInput, ({ text }) => {
				const result = tracker().noteMistake(text);
				if (result.ok) ctx.onMistake?.({ id: result.details.id, text: result.details.text });
				return reply(result);
			}),
		},
		[RESOLVE_MISTAKE_TOOL]: {
			name: RESOLVE_MISTAKE_TOOL,
			label: RESOLVE_MISTAKE_TOOL,
			description:
				"Mark a noted mistake resolved, by the id note_mistake returned — once the learner gets right a problem or check that would have exposed it.",
			parameters: resolveMistakeInput,
			execute: serverExecute(RESOLVE_MISTAKE_TOOL, resolveMistakeInput, ({ id }) => reply(tracker().resolveMistake(id))),
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
			execute: serverExecute(PROBLEM_LIST_TOOL, problemListInput, ({ problems }) => reply(tracker().setProblems(problems))),
		},
		[PROBLEM_START_TOOL]: {
			name: PROBLEM_START_TOOL,
			label: PROBLEM_START_TOOL,
			description: "Mark a problem from the latest problem_list as begun, by id — call it when you begin the problem.",
			parameters: problemStartInput,
			execute: serverExecute(PROBLEM_START_TOOL, problemStartInput, ({ id }) => reply(tracker().startProblem(id))),
		},
		[PROBLEM_DONE_TOOL]: {
			name: PROBLEM_DONE_TOOL,
			label: PROBLEM_DONE_TOOL,
			description:
				"Record how you left a problem from the latest problem_list, by id: outcome correct, incorrect or skipped. A later call replaces the problem's earlier outcome.",
			parameters: problemDoneInput,
			execute: serverExecute(PROBLEM_DONE_TOOL, problemDoneInput, ({ id, outcome }) => reply(tracker().finishProblem(id, outcome))),
		},
		...mistakeTools,
	};
}
