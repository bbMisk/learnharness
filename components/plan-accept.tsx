"use client";

import type { Phase3 } from "@/src/core";

/** The go-ahead "Accept plan" sends (the wording of the retired Teach button). */
export const PLAN_ACCEPT_TEXT = "The plan looks good. Teach it.";

const BUTTON =
	"cursor-pointer rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent";

/** When the plan awaits the learner's go-ahead (owner, 2026-11-05): a teach
 *  lesson in the plan phase, a plan on screen, the tutor stopped, and nothing
 *  else owning the input (a question, an active problem, compaction, a failed
 *  turn waiting for Retry). The accept step no longer depends on the tutor
 *  choosing to ask with a popup. */
export function offersPlanAccept(s: {
	kind: "teach" | "practice";
	phase: Phase3 | undefined;
	hasPlan: boolean;
	sendAllowed: boolean;
	busy: boolean;
	retryable: boolean;
}): boolean {
	return s.kind === "teach" && s.phase === "plan" && s.hasPlan && s.sendAllowed && !s.busy && !s.retryable;
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
