import type { JobRecord } from "./contracts/jobs.ts";

export function jobTaskFromInput(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const value = input as Record<string, unknown>;
	return [value.title, value.question, value.brief, value.context]
		.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
		.join("\n\n").slice(0, 8000) || undefined;
}

/** Presentation only: result generation and lesson delivery have different lifetimes. */
export function jobDisplay(job: JobRecord): { label: string; working: boolean } {
	if (job.status === "error") return { label: "Failed", working: false };
	if (job.status === "done" && job.delivery?.status !== "pending") return { label: "Delivered", working: false };
	if (job.result !== undefined) {
		const label = job.deliveryState === "waiting-answer" ? "Ready — waiting for your answer"
			: job.deliveryState === "waiting-lesson" ? "Ready — waiting for the lesson"
			: job.deliveryState === "delivering" ? "Ready — delivering to lesson" : "Ready";
		return { label, working: false };
	}
	return { label: "Working", working: true };
}

/** Legacy results have no trustworthy generation timestamp; do not invent one. */
export function jobElapsedMs(job: JobRecord, now: number): number | null {
	const end = job.generatedAt ?? (job.result !== undefined ? undefined : job.status === "running" ? now : job.updatedAt);
	if (end === undefined) return null;
	const ms = (typeof end === "number" ? end : Date.parse(end)) - Date.parse(job.createdAt);
	return Number.isFinite(ms) ? Math.max(0, ms) : null;
}
