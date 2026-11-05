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

function learnerText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

/** True while the latest plan presentation has no reply yet (owner,
 *  2026-11-05). Phase stays "plan" until the first tagged check, so the phase
 *  alone can't tell (hunt findings, rounds 1–2):
 *  - a successful plan_init call presents a plan (a failed one doesn't);
 *  - a learner message, or a (successful, not dismissed) answer to a
 *    question asked after the plan, is a reply;
 *  - right after the learner clicks Accept, later plan_init calls (a rewrite
 *    while teaching gets going) don't ask again; a typed message after that
 *    may be a change request, so the next plan asks again. */
export function awaitingPlanReply(messages: readonly ScanMessage[]): boolean {
	const failed = new Set<string>();
	for (const m of messages) {
		if (m.role === "toolResult" && m.toolName === "plan_init" && m.isError && m.toolCallId) failed.add(m.toolCallId);
	}
	let awaiting = false;
	let accepted = false;
	for (const m of messages) {
		if (m.role === "assistant" && Array.isArray(m.content)) {
			const presents = (m.content as Array<{ type?: string; name?: string; id?: string }>).some(
				(b) => b.type === "toolCall" && b.name === "plan_init" && !(b.id && failed.has(b.id)),
			);
			if (presents && !accepted) awaiting = true;
		} else if (m.role === "user") {
			awaiting = false;
			// The Accept button's text accepts; anything else typed may be a
			// change request, whose revised plan asks again (round-3 hunt finding).
			accepted = learnerText(m.content).trim() === PLAN_ACCEPT_TEXT;
		} else if (
			m.role === "toolResult" && !m.isError && (QUESTION_TOOLS as readonly string[]).includes(m.toolName ?? "") &&
			// A dismissed question was not answered (round-4 hunt finding).
			(m.details as { dismissed?: unknown } | undefined)?.dismissed !== true
		) {
			awaiting = false;
		}
	}
	return awaiting;
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
