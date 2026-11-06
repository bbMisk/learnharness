import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult } from "../tool-execute.ts";
import type { DemoResult, JobRecord } from "../../core/contracts/jobs.ts";
import type { JobStore } from "../../core/ports.ts";
import { isPinnableResult, PIN_VISUAL_TOOL, type PinVisualDetails } from "../../core/pinned-visual.ts";

/**
 * pin_visual (owner, 2026-11-06 — core/pinned-visual.ts): pins an earlier
 * demo or diagram beside the chat. SERVER-SIDE and effect-free: the result's
 * details name the job, and the chat page derives the pinned card from the
 * record. Not a question tool, so the turn continues. An unknown target
 * fails the call (an error result the model retries on).
 */

export const PIN_VISUAL_DESCRIPTION =
	"Pin an earlier demo or diagram beside the chat so the learner can use it while reading on. " +
	"Pass its job id (from the dispatch result) or its exact title. " +
	"Pinning replaces any demo or diagram already pinned. It has no other effect and does not end your turn.";

const pinVisualInput = Type.Object({
	visual: Type.String({ description: "The demo's or diagram's job id (job_…), or a demo's exact title." }),
});

export interface PinVisualToolContext {
	chatId: string;
	jobStore: JobStore;
}

function titleOf(job: JobRecord): string | undefined {
	const fromResult = (job.result as DemoResult | undefined)?.title;
	if (typeof fromResult === "string") return fromResult;
	const fromInput = (job.input as { title?: unknown } | undefined)?.title;
	return typeof fromInput === "string" ? fromInput : undefined;
}

function label(job: JobRecord): string {
	const title = titleOf(job);
	return job.kind === "demo" ? `${job.id} (demo "${title ?? "untitled"}")` : `${job.id} (diagram)`;
}

/** The pinnable job `visual` names among the chat's jobs (newest first, so
 *  a repeated title picks the latest), or the error the model reads. */
export function resolvePinTarget(jobs: readonly JobRecord[], visual: string): { job: JobRecord } | { error: string } {
	const key = visual.trim();
	const candidates = jobs.filter((j) => j.kind === "demo" || j.kind === "visual");
	const job = candidates.find((j) => j.id === key) ?? candidates.find((j) => j.kind === "demo" && titleOf(j) === key);
	const ready = candidates.filter((j) => isPinnableResult(j.kind, j.result));
	const list = ready.length > 0
		? `Pinnable now: ${ready.slice(0, 8).map(label).join(", ")}${ready.length > 8 ? ", …" : ""}.`
		: "No demo or diagram has been delivered in this lesson yet.";
	if (!job) return { error: `No demo or diagram in this lesson matches "${key}". Pass a job id from a dispatch result or a demo's exact title. ${list}` };
	if (!isPinnableResult(job.kind, job.result)) {
		return { error: job.result === undefined
			? `${label(job)} has not been delivered yet; pin it after it arrives. ${list}`
			: `${label(job)} failed, so there is nothing to pin. ${list}` };
	}
	return { job };
}

export function pinVisualTool(ctx: PinVisualToolContext): AgentTool<typeof pinVisualInput> {
	return {
		name: PIN_VISUAL_TOOL,
		label: PIN_VISUAL_TOOL,
		description: PIN_VISUAL_DESCRIPTION,
		parameters: pinVisualInput,
		// Instant and local (a job-store read), so no abort guard.
		execute: async (_toolCallId, input) => {
			const found = resolvePinTarget(ctx.jobStore.listJobs(ctx.chatId), input.visual);
			if ("error" in found) return invalidInputResult(PIN_VISUAL_TOOL, [found.error]);
			const details: PinVisualDetails = { ok: true, jobId: found.job.id };
			return { content: [{ type: "text", text: JSON.stringify({ ok: true, pinned: found.job.id }) }], details };
		},
	};
}
