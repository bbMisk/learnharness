/**
 * The full record refresh's apply gate (chat.tsx syncFromServer). A fetched
 * record is a snapshot of the moment its GET was served; applying it replaces
 * the whole view. If the learner sent (a turn started) or the local record
 * otherwise advanced while the GET was in flight, the snapshot predates
 * them and would wipe the live tail — the optimistic learner message
 * vanished while the session stayed "submitted".
 *
 *   apply  nothing moved since the fetch began
 *   skip   a turn started since (or is running with a changed record): its
 *          own settle re-syncs the canonical record
 *   retry  idle, but the local record advanced: fetch again
 *
 * Pure — the view captures `busy` and its native-message array at fetch
 * start and again right before applying.
 */
export interface RecordSyncMoment {
	busy: boolean;
	messages: unknown;
}

export function recordSyncVerdict(start: RecordSyncMoment, now: RecordSyncMoment): "apply" | "skip" | "retry" {
	if (now.busy && !start.busy) return "skip";
	if (now.messages !== start.messages) return now.busy ? "skip" : "retry";
	return "apply";
}
