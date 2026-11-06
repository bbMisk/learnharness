/**
 * The pinned demo or diagram (owner, 2026-11-06): one earlier demo or
 * diagram card can be pinned beside the chat, so the learner can use it
 * while reading on instead of scrolling back to it.
 *
 * Two sources decide what is pinned:
 *   - the tutor's pin_visual calls (src/agent/tools/pin-visual.ts), read
 *     from the record, so a tutor pin survives reloads;
 *   - the learner's own pin and unpin clicks, kept as page state.
 * The pinned item is the target of the most recent successful pin_visual
 * call, unless the learner pinned or unpinned after that call
 * (pinnedJobId).
 *
 * pin_visual never renders in the transcript (view.ts) or the export; a
 * failed call shows the usual "Retrying…" line.
 *
 * Pure and browser-safe (type-only imports).
 */

import type { LhMessage } from "./native-messages.ts";
import type { LhViewMessage } from "./view.ts";
import type { DemoResult, JobKind, SubagentArtifactData, SubagentResultMeta } from "./contracts/jobs.ts";

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

/** The record's latest successful pin_visual call. `live` (client, mid-turn):
 *  executions that ended before their toolResult message arrived count at
 *  their call's position, the lesson-tracking rule (lesson-tracking.ts). */
export function latestTutorPin(
	messages: readonly LhMessage[],
	live?: ReadonlyMap<string, { isError: boolean; output?: unknown }>,
): TutorPin | null {
	let settled: Set<string> | null = null;
	if (live && live.size > 0) {
		settled = new Set();
		for (const m of messages) if (m.role === "toolResult") settled.add(m.toolCallId);
	}
	let latest: TutorPin | null = null;
	for (const m of messages) {
		if (settled && m.role === "assistant") {
			for (const block of m.content) {
				if (block.type !== "toolCall" || block.name !== PIN_VISUAL_TOOL || settled.has(block.id)) continue;
				const execution = live!.get(block.id);
				const jobId = execution && !execution.isError ? pinJobOf(execution.output) : null;
				if (jobId) latest = { callId: block.id, jobId };
			}
			continue;
		}
		if (m.role !== "toolResult" || m.toolName !== PIN_VISUAL_TOOL || m.isError) continue;
		const jobId = pinJobOf(m.details);
		if (jobId) latest = { callId: m.toolCallId, jobId };
	}
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

/** Whether a delivered result is a pinnable card: a built demo or a drawn
 *  figure (failures render as a failure note, not a card). */
export function isPinnableResult(kind: JobKind, result: unknown): boolean {
	if (kind === "demo") return typeof (result as DemoResult | undefined)?.html === "string" && (result as DemoResult).html.length > 0;
	if (kind === "visual") {
		const svg = (result as { svg?: unknown } | undefined)?.svg;
		return typeof svg === "string" && svg.length > 0;
	}
	return false;
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
