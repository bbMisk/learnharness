export const STUDY_IDLE_MS = 120_000;
export const STUDY_SAMPLE_MS = 10_000;
export const STUDY_MAX_SAMPLE_MS = 20_000;
export const STUDY_MAX_AGE_MS = 86_400_000;

export type StudySpan = [start: number, end: number];

/** Coalescing intervals makes retries and activity from overlapping views idempotent. */
export function unionStudySpans(spans: readonly StudySpan[]): StudySpan[] {
	const merged: StudySpan[] = [];
	for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
		const last = merged.at(-1);
		if (last && start <= last[1]) last[1] = Math.max(end, last[1]);
		else merged.push([start, end]);
	}
	return merged;
}

export function studyDuration(spans: readonly StudySpan[], from = -Infinity, to = Infinity): number {
	return spans.reduce((total, [start, end]) => total + Math.max(0, Math.min(to, end) - Math.max(from, start)), 0);
}

/** No credit is granted prospectively. A late timer after sleep/freeze loses
 * the unobserved slice and needs fresh input before it starts again. */
export function createStudyClock(record: (span: StudySpan) => void) {
	let sampledAt: number | undefined;
	let activeUntil = 0;

	function sample(now: number) {
		if (sampledAt === undefined) return;
		const elapsed = now - sampledAt;
		if (elapsed < 0 || elapsed > STUDY_MAX_SAMPLE_MS) {
			sampledAt = undefined;
			return;
		}
		const end = Math.min(now, activeUntil);
		if (end > sampledAt) record([sampledAt, end]);
		sampledAt = now < activeUntil ? now : undefined;
	}
	return {
		sample,
		interact(now: number) {
			if (sampledAt === undefined || now >= activeUntil || now < sampledAt || now - sampledAt > STUDY_MAX_SAMPLE_MS) {
				sample(now);
				sampledAt = now;
			}
			activeUntil = now + STUDY_IDLE_MS;
		},
		pause(now: number) {
			sample(now);
			sampledAt = undefined;
		},
	};
}
