"use client";

import { QUESTION_TOOLS, type Phase3 } from "@/src/core";

/** The go-ahead "Accept plan" sends (the wording of the retired Teach button). */
export const PLAN_ACCEPT_TEXT = "The plan looks good. Teach it.";

const BUTTON =
	"cursor-pointer rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent";

/** When the plan awaits the learner's go-ahead (owner, 2026-11-05): a teach
 *  lesson (not cram, which starts without approval) in the plan phase, a plan
 *  on screen that the learner hasn't answered yet, the tutor stopped, and
 *  nothing else owning the input (a question, an active problem, compaction,
 *  a failed turn waiting for Retry). The accept step no longer depends on the
 *  tutor choosing to ask with a popup. */
export function offersPlanAccept(s: {
	kind: "teach" | "practice";
	cram: boolean;
	phase: Phase3 | undefined;
	hasPlan: boolean;
	awaitingReply: boolean;
	sendAllowed: boolean;
	busy: boolean;
	retryable: boolean;
}): boolean {
	return s.kind === "teach" && !s.cram && s.phase === "plan" && s.hasPlan && s.awaitingReply && s.sendAllowed && !s.busy && !s.retryable;
}

type ScanMessage = { role?: string; content?: unknown; toolName?: string; toolCallId?: string; isError?: boolean; details?: unknown };

/** A real answer to a question: not a failed call, a streamed placeholder
 *  (details null) or a dismissal. */
function answersQuestion(m: ScanMessage): boolean {
	if (m.role !== "toolResult" || m.isError || !(QUESTION_TOOLS as readonly string[]).includes(m.toolName ?? "")) return false;
	return !!m.details && typeof m.details === "object" && (m.details as { dismissed?: unknown }).dismissed !== true;
}

/** True while the latest plan has no reply yet (owner, 2026-11-05): of a
 *  presented plan (a plan_init whose result succeeded, `details.ok` as the
 *  plan popup reads it — an invalid map returns ok: false without isError),
 *  a learner message and a real answer to a question, the latest is the plan.
 *  Phase stays "plan" until the first tagged check, so the phase alone can't
 *  tell. A rewrite right after Accept shows the buttons again; accepting
 *  twice is harmless. */
export function awaitingPlanReply(messages: readonly ScanMessage[]): boolean {
	const presented = new Set<string>();
	for (const m of messages) {
		if (m.role === "toolResult" && m.toolName === "plan_init" && !m.isError && m.toolCallId && (m.details as { ok?: unknown } | undefined)?.ok === true) presented.add(m.toolCallId);
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "user" || answersQuestion(m)) return false;
		if (m.role === "assistant" && Array.isArray(m.content) && (m.content as Array<{ type?: string; name?: string; id?: string }>).some((b) => b.type === "toolCall" && b.name === "plan_init" && !!b.id && presented.has(b.id))) return true;
	}
	return false;
}

/** Two buttons above the composer: Accept sends the go-ahead; Change hands
 *  the learner the composer to say what to change. */
export function PlanAcceptBar({ onAccept, onChange }: { onAccept: () => void; onChange: () => void }) {
	return (
		<div className="pointer-events-auto mb-2 flex justify-center gap-2" data-testid="plan-accept">
			<button type="button" data-testid="plan-accept-yes" className={BUTTON} onClick={onAccept}>
				Accept plan
			</button>
			<button type="button" data-testid="plan-accept-change" className={BUTTON} onClick={onChange}>
				Change something
			</button>
		</div>
	);
}
