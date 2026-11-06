"use client";

import { ToolContentResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import type { ArtifactPartProps } from "@/src/core";

/**
 * The practice transcript cards (practice sessions, owner design
 * 2026-10-04): three quiet records in the stream —
 *
 * - ProblemCard — a posed problem: the statement, compact-expandable
 *   (like every card here; the dock is the working surface, this is the
 *   record). The commitment NEVER renders — only the call's statement.
 * - ConcludeCard — the conclusion: outcome badge + verdict + the reveal
 *   (the committed solution, shown when the problem ended). A dismissal
 *   synthesis (outcome:"dismissed") renders as one muted line.
 * - ThinkingCard — the learner's own submission, user-side: the register
 *   is the two buttons' (Nudge = working trace, Commit = answer). The
 *   UNIFIED ThinkingBlock (owner round 2026-10-05): the quiz quote-block
 *   language in a faint user-side shell, never collapsible.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ThinkingBlock } from "@/components/thinking-block";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { safeAreaInsets } from "@/components/safe-area";

/* TARGET NAMES (owner round 17, 2026-10-06): targets are normalized to
 * opaque node ids at the record seam (owner round 9 — the mastery trace
 * groups on them), so the drawer resolves names at render time. One
 * lazy module-cached fetch of the graph view (the id → name map is a
 * few KB); failures degrade to raw ids — observability never breaks the
 * card. */
let nodeNameMapPromise: Promise<Record<string, string>> | null = null;
function nodeNameMap(): Promise<Record<string, string>> {
	nodeNameMapPromise ??= fetch("/api/graph")
		.then((r) => (r.ok ? r.json() : { nodes: [] }))
		.then((g: { nodes?: Array<{ id?: unknown; name?: unknown }> }) =>
			Object.fromEntries(
				(g.nodes ?? [])
					.filter((n) => typeof n.id === "string")
					.map((n) => [n.id as string, typeof n.name === "string" ? (n.name as string) : (n.id as string)]),
			),
		)
		.catch(() => ({}));
	return nodeNameMapPromise;
}

/** The practice-thinking marker's details (native-messages.ts). */
export interface PracticeThinkingData {
	problemCallId: string;
	/** Legacy records (pre 2026-10-05) carry the old two-lane flag; ignored. */
	commit?: boolean;
	text: string;
}

export function ProblemCard({ part }: ArtifactPartProps) {
	// Always open, no chevron (owner round, 2026-10-05): the record IS the
	// statement — same container + eyebrow discipline as the answered card
	// and the dock (which mirrors this in Slice D). The commitment never
	// renders — only the call's statement.
	const input = (part.input ?? {}) as { statement?: string };
	const statement = typeof input.statement === "string" ? input.statement : "";
	return (
		<div data-testid="problem-card" className="lh-card-enter my-1 rounded-xl border bg-card p-4">
			<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Problem</div>
			<div className="lh-prose text-[15px]">
				<ToolContentResponse>{statement}</ToolContentResponse>
			</div>
		</div>
	);
}

const OUTCOME_LABEL: Record<string, string> = {
	solved: "Solved",
	solvedWithHints: "Solved with hints",
	movedOn: "Moved on",
	surrendered: "Surrendered",
	dismissed: "Dismissed",
};

/* The outcome chips (owner round 3, 2026-10-05): the EXACT register of the
 * quiz cards' correct/incorrect bubbles. Colors per outcome — solved reads
 * green (the "correct" twin), solved-with-hints amber (succeeded with
 * cost), surrendered red (the problem beat the learner), moved on muted
 * (the agent's call, not a verdict against him). */
const OUTCOME_CHIP: Record<string, string> = {
	solved: "bg-green-500/15 text-green-500",
	solvedWithHints: "bg-amber-500/15 text-amber-500",
	movedOn: "bg-muted text-muted-foreground",
	surrendered: "bg-red-500/15 text-red-500",
	dismissed: "bg-muted text-muted-foreground",
};

export function ConcludeCard({ part }: ArtifactPartProps) {
	// The conclusion redesigned (owner round, 2026-10-05): the SOLUTION is
	// the hero — the modelSolution committed at pose time (part.reveal, the
	// view-seam join), shown verbatim, never re-authored. The verdict sits
	// below in the quiz-explanation register (small, muted, low-key).
	// Nothing collapsible. Legacy inputs (pre-slim records) that carry
	// their own solutionReveal fall back to it.
	const input = (part.input ?? {}) as { outcome?: string; verdict?: string; solutionReveal?: string };
	const outcome = typeof input.outcome === "string" ? input.outcome : "";
	const verdict = typeof input.verdict === "string" ? input.verdict : "";
	const reveal =
		typeof part.reveal === "string" ? part.reveal : typeof input.solutionReveal === "string" ? input.solutionReveal : "";

	// The dismissal synthesis: no verdict, no reveal — one muted line (the
	// learner clicked; the record needs only the fact).
	if (outcome === "dismissed") {
		return (
			<div data-testid="conclude-card" className="my-1 px-1 text-sm text-muted-foreground/70">
				Problem dismissed.
			</div>
		);
	}

	return (
		<div data-testid="conclude-card" className="lh-card-enter relative my-1 rounded-xl border bg-card p-4">
			{/* The heading row (owner round 3, 2026-10-05): plain 'Concluded'
			    eyebrow + the outcome in the quiz cards' EXACT chip register —
			    no more two same-weight headings stacked. */}
			<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Concluded
				{(OUTCOME_LABEL[outcome] ?? "") !== "" && outcome !== "dismissed" && (
					<span className={cn("rounded px-1.5 py-0.5", OUTCOME_CHIP[outcome] ?? OUTCOME_CHIP.movedOn)}>
						{OUTCOME_LABEL[outcome]}
					</span>
				)}
			</div>
			{/* The verdict — plain prose under the heading, no 'Verdict:' label
			    (owner round 3): the same quiet 50% register as quiz explanations. */}
			{verdict.length > 0 && (
				<div className="text-sm text-foreground/50">
					<ToolContentResponse>{verdict}</ToolContentResponse>
				</div>
			)}
			{/* Then the divider, then the labeled model solution (Slice G: the
			    hero is the pose's commitment, verbatim). */}
			{reveal.length > 0 && (
				<>
					<div className="my-3 border-t" />
					<div>
						<div className="mb-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Model solution</div>
						<div className="lh-prose text-[15px]">
							<ToolContentResponse>{reveal}</ToolContentResponse>
						</div>
					</div>
				</>
			)}
			<MetadataPopover
				concludeInput={input}
				problemInput={(part.problemInput ?? {}) as { mode?: unknown; target?: unknown }}
			/>
		</div>
	);
}

/* The metadata popover: a quiet METADATA trigger at the bottom of the
 * conclude card opens an info box (the graph-view node cards' register)
 * showing every field the agent filled in the problem call (mode, targets —
 * names resolved lazily) and the conclude call (outcome, rung, miss class,
 * retest). Statement and model solution stay out: they are the visible card.
 * The box opens below the trigger, or above it when the safe area leaves
 * less room below. Esc, a click outside, an outside scroll or a resize
 * closes it. */
function MetadataPopover({
	concludeInput,
	problemInput,
}: {
	concludeInput: { outcome?: string; rung?: unknown; missClass?: unknown; retest?: unknown };
	problemInput: { mode?: unknown; target?: unknown };
}) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);
	// The portal's anchor: placed from the trigger's viewport rect at open
	// time — an outside scroll or a resize closes the box, so there is
	// nothing to track.
	const [anchor, setAnchor] = useState<{ top?: number; bottom?: number; left: number; maxHeight?: number } | null>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const [names, setNames] = useState<Record<string, string> | null>(null);
	const targets = Array.isArray(problemInput.target)
		? problemInput.target.filter((t): t is string => typeof t === "string")
		: [];
	// Resolve names only when there is something to resolve.
	useEffect(() => {
		if (!open || targets.length === 0 || names) return;
		let alive = true;
		void nodeNameMap().then((m) => {
			if (alive) setNames(m);
		});
		return () => {
			alive = false;
		};
	}, [open, targets.length, names]);

	usePopoverDismiss(rootRef, open, () => setOpen(false));
	// Any outside scroll closes it: capture-phase, so every scroller in the
	// tree counts — the transcript's own scroll included. Scrolling inside
	// the box (it scrolls when capped) does not.
	useEffect(() => {
		if (!open) return;
		const close = () => setOpen(false);
		const onScroll = (e: Event) => {
			if (!(e.target instanceof Node && boxRef.current?.contains(e.target))) close();
		};
		window.addEventListener("scroll", onScroll, { capture: true, passive: true });
		// A resize/rotation closes it too: its fixed coordinates would be stale.
		window.addEventListener("resize", close);
		return () => {
			window.removeEventListener("scroll", onScroll, { capture: true });
			window.removeEventListener("resize", close);
		};
	}, [open]);

	const mode = typeof problemInput.mode === "string" ? problemInput.mode : "";
	const rung = typeof concludeInput.rung === "string" ? concludeInput.rung : "";
	const miss = typeof concludeInput.missClass === "string" ? concludeInput.missClass : "";
	const retest = typeof concludeInput.retest === "boolean" ? concludeInput.retest : undefined;
	const outcome = typeof concludeInput.outcome === "string" ? concludeInput.outcome : "";
	if (!mode && targets.length === 0 && !rung && !miss && retest === undefined) return null;

	return (
		<div ref={rootRef} className="relative mt-3">
			<button
				type="button"
				data-testid="metadata-toggle"
				ref={triggerRef}
				onClick={() => {
					setOpen((v) => {
						if (v) return false;
						const r = triggerRef.current?.getBoundingClientRect();
						if (r) {
							// Below the trigger; clamped so the 320px box never leaves
							// the viewport's right edge, and (iPhone/iPad Home Screen
							// app) the safe area. Zero insets: unchanged.
							const safe = safeAreaInsets();
							const left = Math.max(8 + safe.left, Math.min(r.left, window.innerWidth - 328 - safe.right));
							const top = r.bottom + 8;
							if (safe.bottom > 0 || safe.top > 0) {
								// Safe rectangle only: open above when below has less room.
								const below = window.innerHeight - safe.bottom - 8 - top;
								const above = r.top - 8 - 8 - safe.top;
								if (below < 96 && above > below) setAnchor({ bottom: window.innerHeight - r.top + 8, left, maxHeight: above });
								else setAnchor({ top, left, maxHeight: Math.max(0, below) });
							} else setAnchor({ top, left });
						}
						return true;
					});
				}}
				aria-expanded={open}
				className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
			>
				Metadata
			</button>
			{open &&
				anchor &&
				createPortal(
					<div
						ref={boxRef}
						data-testid="metadata-box"
						// Portaled to body: the transcript's MessageContent boxes
						// carry overflow-hidden, which would clip an absolutely
						// positioned child at its message block's edge.
						style={{ position: "fixed", ...(anchor.bottom !== undefined ? { bottom: anchor.bottom } : { top: anchor.top }), left: anchor.left, ...(anchor.maxHeight !== undefined ? { maxHeight: anchor.maxHeight, overflowY: "auto" as const } : {}) }}
						className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-xl border bg-card p-4 text-left shadow-lg"
					>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
						<dt className="text-muted-foreground">Mode</dt>
						<dd className="font-mono">{mode || "—"}</dd>
						<dt className="text-muted-foreground">Targets</dt>
						<dd className="font-mono">
							{targets.length === 0 ? (
								"untagged"
							) : (
								<span>
									{targets.map((t, i) => (
										<span key={t}>
											{i > 0 && ", "}
											{names?.[t] ?? t}
										</span>
									))}
								</span>
							)}
						</dd>
						<dt className="text-muted-foreground">Outcome</dt>
						<dd className="font-mono">{outcome || "—"}</dd>
						<dt className="text-muted-foreground">Hint rung</dt>
						<dd className="font-mono">{rung || "none"}</dd>
						<dt className="text-muted-foreground">Miss class</dt>
						<dd className="font-mono">{miss || "none"}</dd>
						<dt className="text-muted-foreground">Retest</dt>
						<dd className="font-mono">{retest === undefined ? "—" : retest ? "yes" : "no"}</dd>
					</dl>
					</div>,
					document.body,
				)}
		</div>
	);
}

export function ThinkingCard({ data }: { data: PracticeThinkingData }) {
	// The unified row (owner rounds, 2026-10-05): one style, one label —
	// 50%-italic quote block on expand. Legacy records' commit flag is
	// deliberately unread (one lane now). A TRANSCRIPT row (owner round,
	// 2026-10-07): full-width band + rail, arriving expanded.
	return <ThinkingBlock testId="thinking-card" label="YOUR THINKING" text={data.text} defaultOpen />;
}
