/**
 * Which demo or diagram is pinned beside the chat: the target of the latest
 * successful pin_visual call (read from the record, so it survives reloads),
 * unless the learner pinned or unpinned after that call (pinnedJobId).
 */

import { forEachToolSuccess, type LhMessage } from "./native-messages.ts";
import type { LhViewMessage } from "./view.ts";
import { isSubagentFailure, type DemoResult, type SubagentArtifactData, type SubagentResultMeta, type VisualResult } from "./contracts/jobs.ts";

export const PIN_VISUAL_TOOL = "pin_visual";

/** A successful pin_visual result's `details`. */
export interface PinVisualDetails {
	ok: true;
	jobId: string;
}

/** The latest successful tutor pin: its call id and target job. */
export interface TutorPin {
	callId: string;
	jobId: string;
}

/** The learner's latest pin or unpin click. `afterCall` is the tutor pin
 *  that was latest at the click (null before any), so a newer tutor pin
 *  takes over again. */
export interface ManualPin {
	afterCall: string | null;
	/** null = unpinned. */
	jobId: string | null;
}

function pinJobOf(details: unknown): string | null {
	const d = details as { ok?: unknown; jobId?: unknown } | null | undefined;
	return d && d.ok === true && typeof d.jobId === "string" ? d.jobId : null;
}

/** The record's latest successful pin_visual call (with the client's live
 *  executions mid-turn — forEachToolSuccess). */
export function latestTutorPin(
	messages: readonly LhMessage[],
	live?: ReadonlyMap<string, { isError: boolean; output?: unknown }>,
): TutorPin | null {
	let latest: TutorPin | null = null;
	forEachToolSuccess(messages, (name) => name === PIN_VISUAL_TOOL, live, (_name, callId, details) => {
		const jobId = pinJobOf(details);
		if (jobId) latest = { callId, jobId };
	});
	return latest;
}

/** The pinned job id: the learner's click while no newer tutor pin exists,
 *  else the latest tutor pin, else nothing. */
export function pinnedJobId(tutor: TutorPin | null, manual: ManualPin | null): string | null {
	if (manual && manual.afterCall === (tutor?.callId ?? null)) return manual.jobId;
	return tutor?.jobId ?? null;
}

/** A demo or diagram card in the transcript that can be pinned. */
export interface PinTarget {
	jobId: string;
	kind: "demo" | "visual";
	/** The demo's title; diagrams have none ("Figure"). */
	title: string;
}

/** A delivered demo or figure that rendered as a card (not a failure note). */
export function isPinnableResult(kind: "demo" | "visual", result: unknown): boolean {
	return result != null && !isSubagentFailure(kind, result as DemoResult | VisualResult);
}

/** The transcript card for `jobId`, or null when it is not (yet) shown. */
export function pinTargetOf(messages: readonly LhViewMessage[], jobId: string | null): PinTarget | null {
	if (!jobId) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		const meta = (m.metadata as { subagentResult?: SubagentResultMeta } | undefined)?.subagentResult;
		if (meta?.jobId !== jobId) continue;
		const data = m.parts.find((p) => p.type === "data-subagent-artifact")?.data as SubagentArtifactData | undefined;
		if (!data || (data.kind !== "demo" && data.kind !== "visual") || !isPinnableResult(data.kind, data.result)) return null;
		return { jobId, kind: data.kind, title: data.kind === "demo" ? (data.result as DemoResult).title : "Figure" };
	}
	return null;
}
