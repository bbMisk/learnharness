/**
 * Lesson tracking (owner, 2026-11-02): the cram teacher's problem set and
 * the teacher's mistake log, shown to the learner in the chat's tracking
 * card (components/lesson-tracker.tsx).
 *
 * Five server-side tools write it (src/agent/tools/lesson-tracking.ts):
 *   problem_list({ problems })      — cram teacher only; replaces the list
 *   problem_start({ id })           — cram teacher only
 *   problem_done({ id, outcome })   — cram teacher only; correct | incorrect | skipped
 *   note_mistake({ text })          — every teacher (teach + cram); mints m1, m2…
 *   resolve_mistake({ id })         — every teacher
 *
 * NO separate storage: the state is DERIVED from the record's successful
 * tool results, whose `details` carry exactly what the fold needs (the
 * plan_init pattern: content is the slim model-facing ack, details the
 * record-facing data). Compaction keeps the full record, so the fold —
 * which reads the record, never the model's kept context — survives it,
 * reloads, and every device. The server tools and the client card run
 * this SAME fold, so the ids the tools validate against are the ids the
 * card shows.
 *
 * Problem statuses (owner, 2026-11-03) follow the plan map's rule
 * (contracts/plan.ts): the list carries structure, statuses derive from the
 * record's start/done events by id, and only ids in the LATEST list display
 * — a re-list keeps the outcomes of the problems it keeps.
 *   outcome — from the problem's LATEST problem_done (a correct redo turns a
 *             ✗ green); a legacy problem_done with no outcome is "correct".
 *   current — the most recently started problem with no problem_done after
 *             that start (a finished problem started again is current
 *             again until its next problem_done); null when none.
 *
 * Pure and browser-safe (type-only imports).
 */

import type { LhMessage } from "./native-messages.ts";

export const PROBLEM_LIST_TOOL = "problem_list";
export const PROBLEM_START_TOOL = "problem_start";
export const PROBLEM_DONE_TOOL = "problem_done";
export const NOTE_MISTAKE_TOOL = "note_mistake";
export const RESOLVE_MISTAKE_TOOL = "resolve_mistake";

/** The tracking tools: hidden from the transcript (view.ts) and the export. */
export const LESSON_TRACKING_TOOLS: readonly string[] = [
	PROBLEM_LIST_TOOL,
	PROBLEM_START_TOOL,
	PROBLEM_DONE_TOOL,
	NOTE_MISTAKE_TOOL,
	RESOLVE_MISTAKE_TOOL,
];

export function isLessonTrackingTool(name: string): boolean {
	return LESSON_TRACKING_TOOLS.includes(name);
}

/** How the teacher left a problem (problem_done's outcome). */
export type ProblemOutcome = "correct" | "incorrect" | "skipped";
export const PROBLEM_OUTCOMES: readonly ProblemOutcome[] = ["correct", "incorrect", "skipped"];

export interface TrackedProblem {
	id: string;
	label: string;
	/** From the latest problem_done; null before any. */
	outcome: ProblemOutcome | null;
	/** The one problem in progress (see the module note). */
	current: boolean;
}

export interface TrackedMistake {
	id: string;
	text: string;
	resolved: boolean;
}

/** The derived view: `problems` is null until a list exists. */
export interface LessonTracking {
	problems: TrackedProblem[] | null;
	mistakes: TrackedMistake[];
}

/** A successful tracking result's record-facing `details`, per tool. */
export type ProblemListDetails = { ok: true; problems: Array<{ id: string; label: string }> };
export type ProblemStartDetails = { ok: true; id: string };
export type ProblemDoneDetails = { ok: true; id: string; outcome: ProblemOutcome };
export type NoteMistakeDetails = { ok: true; id: string; text: string };
export type ResolveMistakeDetails = { ok: true; id: string };

function isString(v: unknown): v is string {
	return typeof v === "string";
}

/**
 * The fold's running state. The tools keep one per turn (seeded from the
 * record, then fed their own successful results); the card folds the
 * record from scratch. `apply` is the single reducer both use.
 */
export class LessonTracker {
	private list: Array<{ id: string; label: string }> | null = null;
	/** Event order: every start/done takes the next sequence number. */
	private seq = 0;
	private readonly lastStart = new Map<string, number>();
	private readonly lastDone = new Map<string, number>();
	private readonly outcomes = new Map<string, ProblemOutcome>();
	private readonly mistakes: TrackedMistake[] = [];

	/** Fold one successful tracking result (unknown tools/shapes: ignored). */
	apply(toolName: string, details: unknown): void {
		const d = details as Record<string, unknown> | null | undefined;
		if (!d || typeof d !== "object" || d.ok !== true) return;
		switch (toolName) {
			case PROBLEM_LIST_TOOL: {
				if (!Array.isArray(d.problems)) return;
				this.list = (d.problems as Array<{ id?: unknown; label?: unknown }>)
					.filter((p) => p && isString(p.id) && isString(p.label))
					.map((p) => ({ id: p.id as string, label: p.label as string }));
				return;
			}
			case PROBLEM_START_TOOL:
				if (isString(d.id)) this.lastStart.set(d.id, ++this.seq);
				return;
			case PROBLEM_DONE_TOOL:
				if (!isString(d.id)) return;
				this.lastDone.set(d.id, ++this.seq);
				// Legacy records (before outcomes, 2026-11-03) meant "correct".
				this.outcomes.set(d.id, PROBLEM_OUTCOMES.includes(d.outcome as ProblemOutcome) ? (d.outcome as ProblemOutcome) : "correct");
				return;
			case NOTE_MISTAKE_TOOL:
				if (isString(d.id) && isString(d.text) && !this.mistake(d.id)) {
					this.mistakes.push({ id: d.id, text: d.text, resolved: false });
				}
				return;
			case RESOLVE_MISTAKE_TOOL: {
				const m = isString(d.id) ? this.mistake(d.id) : undefined;
				if (m) m.resolved = true;
				return;
			}
		}
	}

	/** The latest list's ids, or null before any list. */
	problemIds(): string[] | null {
		return this.list ? this.list.map((p) => p.id) : null;
	}

	mistake(id: string): TrackedMistake | undefined {
		return this.mistakes.find((m) => m.id === id);
	}

	/** The next note_mistake id: m1, m2, … in record order, per chat. */
	nextMistakeId(): string {
		return `m${this.mistakes.length + 1}`;
	}

	/** The current problem among the latest list's ids, or null. */
	private currentId(): string | null {
		let current: string | null = null;
		let at = 0;
		for (const p of this.list ?? []) {
			const start = this.lastStart.get(p.id) ?? 0;
			if (start > (this.lastDone.get(p.id) ?? 0) && start > at) {
				current = p.id;
				at = start;
			}
		}
		return current;
	}

	snapshot(): LessonTracking {
		const current = this.currentId();
		return {
			problems: this.list
				? this.list.map((p) => ({ ...p, outcome: this.outcomes.get(p.id) ?? null, current: p.id === current }))
				: null,
			mistakes: this.mistakes.map((m) => ({ ...m })),
		};
	}
}

/** A live turn's tool execution outcome (the client's tool_execution_end
 *  layer — view.ts LiveExecution): `output` is the result's details. */
export interface LiveTrackingExecution {
	isError: boolean;
	output?: unknown;
}

/** Fold the record's successful tracking results into a tracker.
 *  `live` (client only): executions that ended before their toolResult
 *  message arrived (results land at turn_end, after the step's slowest
 *  tool) fold at their call's position; once the native result exists it
 *  is the only one that counts, so nothing folds twice. */
export function lessonTrackerOf(
	messages: readonly LhMessage[],
	live?: ReadonlyMap<string, LiveTrackingExecution>,
): LessonTracker {
	const tracker = new LessonTracker();
	let settled: Set<string> | null = null;
	if (live && live.size > 0) {
		settled = new Set();
		for (const m of messages) {
			const r = m as { role?: string; toolCallId?: unknown };
			if (r.role === "toolResult" && isString(r.toolCallId)) settled.add(r.toolCallId);
		}
	}
	for (const m of messages) {
		const r = m as { role?: string; toolName?: unknown; isError?: unknown; details?: unknown; content?: unknown };
		if (settled && r.role === "assistant" && Array.isArray(r.content)) {
			for (const block of r.content as Array<{ type?: string; id?: unknown; name?: unknown }>) {
				if (block.type !== "toolCall" || !isString(block.id) || !isString(block.name)) continue;
				if (!isLessonTrackingTool(block.name) || settled.has(block.id)) continue;
				const execution = live!.get(block.id);
				if (execution && !execution.isError) tracker.apply(block.name, execution.output);
			}
			continue;
		}
		if (r.role !== "toolResult" || r.isError === true || !isString(r.toolName)) continue;
		if (!isLessonTrackingTool(r.toolName)) continue;
		tracker.apply(r.toolName, r.details);
	}
	return tracker;
}

/** The derived tracking state of a record (the card's input), plus — on
 *  the client, mid-turn — the live layer's ended executions. */
export function deriveLessonTracking(
	messages: readonly LhMessage[],
	live?: ReadonlyMap<string, LiveTrackingExecution>,
): LessonTracking {
	return lessonTrackerOf(messages, live).snapshot();
}

/**
 * The one pure-data line the compaction marker carries (owner, 2026-11-02):
 * the tracker ids can fall into the condensed-away history, so the summary
 * the tutor sees after a cut ends with the state, e.g.
 *   Lesson tracking: problems q1 "Q1: binomial MLE" ✓, q2 "Q2: CRLB" ✗, q3 "Q3: sufficiency" skipped, q4 "Q4: MoM" current, q5 "Q5: UMVUE" open; open mistakes m1 "dropped the sign of the score"
 * A problem reads current while in progress (its old outcome, if restarted,
 * returns with its next problem_done), else its outcome, else open.
 * Each problem carries its label so the tutor can tell which id is which once
 * the problem_list call is condensed away (owner, 2026-11-02, round-2 hunt).
 * The problems part needs a list, the mistakes part an open mistake; null
 * when neither exists.
 */
export function lessonTrackingLine(tracking: LessonTracking): string | null {
	const parts: string[] = [];
	if (tracking.problems) {
		parts.push(`problems ${tracking.problems.map((p) => `${p.id} ${JSON.stringify(p.label)} ${problemStatusWord(p)}`).join(", ")}`);
	}
	const open = tracking.mistakes.filter((m) => !m.resolved);
	// Quoted as JSON so a quote inside a mistake can't read as a second entry (round-3 hunt).
	if (open.length > 0) parts.push(`open mistakes ${open.map((m) => `${m.id} ${JSON.stringify(m.text)}`).join(", ")}`);
	return parts.length > 0 ? `Lesson tracking: ${parts.join("; ")}` : null;
}

const OUTCOME_WORD: Record<ProblemOutcome, string> = { correct: "✓", incorrect: "✗", skipped: "skipped" };

function problemStatusWord(p: TrackedProblem): string {
	if (p.current) return "current";
	return p.outcome ? OUTCOME_WORD[p.outcome] : "open";
}

/** Correct problems / all problems: the card's header count. */
export function correctProblemCount(problems: readonly TrackedProblem[]): number {
	return problems.filter((p) => p.outcome === "correct" && !p.current).length;
}

/** Anything for the card to show: a problem list or any mistake. */
export function hasLessonTracking(tracking: LessonTracking): boolean {
	return tracking.problems !== null || tracking.mistakes.length > 0;
}
