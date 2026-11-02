/**
 * Lesson tracking (owner, 2026-11-02): the cram teacher's problem set and
 * the teacher's mistake log, shown to the learner in the chat's tracking
 * card (components/lesson-tracker.tsx).
 *
 * Four server-side tools write it (src/agent/tools/lesson-tracking.ts):
 *   problem_list({ problems })  — cram teacher only; replaces the list
 *   problem_done({ id })        — cram teacher only
 *   note_mistake({ text })      — every teacher (teach + cram); mints m1, m2…
 *   resolve_mistake({ id })     — every teacher
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
 * Problem statuses follow the plan map's rule (contracts/plan.ts): the
 * list carries structure, completion derives from every problem_done in
 * the record, and only ids in the LATEST list display — a re-list keeps
 * the ticks of the problems it keeps.
 *
 * Pure and browser-safe (type-only imports).
 */

import type { LhMessage } from "./native-messages.ts";

export const PROBLEM_LIST_TOOL = "problem_list";
export const PROBLEM_DONE_TOOL = "problem_done";
export const NOTE_MISTAKE_TOOL = "note_mistake";
export const RESOLVE_MISTAKE_TOOL = "resolve_mistake";

/** The four tracking tools: hidden from the transcript (view.ts). */
export const LESSON_TRACKING_TOOLS: readonly string[] = [
	PROBLEM_LIST_TOOL,
	PROBLEM_DONE_TOOL,
	NOTE_MISTAKE_TOOL,
	RESOLVE_MISTAKE_TOOL,
];

export function isLessonTrackingTool(name: string): boolean {
	return LESSON_TRACKING_TOOLS.includes(name);
}

export interface TrackedProblem {
	id: string;
	label: string;
	done: boolean;
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
export type ProblemDoneDetails = { ok: true; id: string };
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
	private readonly done = new Set<string>();
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
			case PROBLEM_DONE_TOOL:
				if (isString(d.id)) this.done.add(d.id);
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

	snapshot(): LessonTracking {
		return {
			problems: this.list ? this.list.map((p) => ({ ...p, done: this.done.has(p.id) })) : null,
			mistakes: this.mistakes.map((m) => ({ ...m })),
		};
	}
}

/** Fold the record's successful tracking results into a tracker. */
export function lessonTrackerOf(messages: readonly LhMessage[]): LessonTracker {
	const tracker = new LessonTracker();
	for (const m of messages) {
		const r = m as { role?: string; toolName?: unknown; isError?: unknown; details?: unknown };
		if (r.role !== "toolResult" || r.isError === true || !isString(r.toolName)) continue;
		if (!isLessonTrackingTool(r.toolName)) continue;
		tracker.apply(r.toolName, r.details);
	}
	return tracker;
}

/** The derived tracking state of a record (the card's input). */
export function deriveLessonTracking(messages: readonly LhMessage[]): LessonTracking {
	return lessonTrackerOf(messages).snapshot();
}

/** Anything for the card to show: a problem list or any mistake. */
export function hasLessonTracking(tracking: LessonTracking): boolean {
	return tracking.problems !== null || tracking.mistakes.length > 0;
}
