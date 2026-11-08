/**
 * Time spent on a lesson (owner, 2026-11-05): an optional figure on each
 * sidebar row (Settings → General, off by default). Measured from the
 * lesson record only — no live activity tracking.
 *
 * Active time is the sum of the gaps between consecutive timestamped
 * record messages (learner and assistant messages, tool results, custom
 * markers — every LhMessage carries `timestamp`, Unix ms; an assistant's is
 * when its request started). A gap longer than BREAK_AFTER_MS, or
 * OPEN_BREAK_AFTER_MS while a question or a problem is open during it, is a
 * break and counts nothing; a shorter gap counts in full:
 *   question — a QUESTION_TOOLS call (core/pending.ts) whose result has not
 *              arrived. Like the question gate (native-messages.ts
 *              questionCallsOf), only the newest assistant message's calls
 *              can be open, and a failed or aborted generation poses none.
 *   problem  — a cram problem started by problem_start and not yet left by
 *              problem_done: the tracker's current problem
 *              (core/lesson-tracking.ts, the card's own fold).
 * The state after a message decides the threshold of the gap that follows it.
 * Nothing counts before the first timestamp or after the last. A timestamp
 * at or before the latest one seen (an out-of-order message) adds nothing,
 * and the next gap is measured from that latest time, so no stretch of time
 * counts twice. Messages without a finite timestamp are skipped for timing
 * but still update the open state.
 *
 * Pure and browser-safe (type-only imports plus pure modules).
 */

import type { LhMessage } from "./native-messages.ts";
import { QUESTION_TOOLS } from "./pending.ts";
import { LessonTracker, PROBLEM_DONE_TOOL, PROBLEM_LIST_TOOL, PROBLEM_START_TOOL } from "./lesson-tracking.ts";

const MINUTE_MS = 60_000;
/** A longer gap while nothing is open is a break. */
export const BREAK_AFTER_MS = 10 * MINUTE_MS;
/** A longer gap while a question or problem is open is a break. */
export const OPEN_BREAK_AFTER_MS = 25 * MINUTE_MS;

/** The record's measured active time, in ms (0 when nothing measurable). */
export function lessonTimeMs(messages: readonly LhMessage[]): number {
	let total = 0;
	let latest: number | null = null;
	let openQuestions = new Set<string>();
	const tracker = new LessonTracker();
	let problemOpen = false;
	for (const m of messages) {
		const t = (m as { timestamp?: unknown }).timestamp;
		if (typeof t === "number" && Number.isFinite(t)) {
			if (latest !== null && t > latest) {
				const breakAfter = openQuestions.size > 0 || problemOpen ? OPEN_BREAK_AFTER_MS : BREAK_AFTER_MS;
				if (t - latest <= breakAfter) total += t - latest;
			}
			if (latest === null || t > latest) latest = t;
		}
		if (m.role === "assistant") {
			// The newest assistant's calls only: older unanswered calls never revive.
			openQuestions = new Set();
			if (m.stopReason === "error" || m.stopReason === "aborted") continue;
			for (const block of m.content) {
				if (block.type === "toolCall" && (QUESTION_TOOLS as readonly string[]).includes(block.name)) openQuestions.add(block.id);
			}
		} else if (m.role === "toolResult") {
			openQuestions.delete(m.toolCallId);
			if (m.isError) continue;
			if (m.toolName === PROBLEM_LIST_TOOL || m.toolName === PROBLEM_START_TOOL || m.toolName === PROBLEM_DONE_TOOL) {
				tracker.apply(m.toolName, m.details);
				problemOpen = tracker.snapshot().problems?.some((p) => p.current) ?? false;
			}
		}
	}
	return total;
}

const TEN_MINUTES_MS = 10 * MINUTE_MS;

/** The sidebar's figure: rounded to the nearest 10 minutes — "<10m" under
 *  5 minutes, then "10m", "50m", "1h", "1h 20m", "12h 40m". Null (show
 *  nothing) when the lesson has no measurable time. */
export function formatLessonTime(ms: number | null | undefined): string | null {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
	const minutes = Math.round(ms / TEN_MINUTES_MS) * 10;
	if (minutes === 0) return "<10m";
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours === 0) return `${rest}m`;
	return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
