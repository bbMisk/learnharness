"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ListChecksIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { correctProblemCount, lessonWeakSpots, type LessonTracking, type PlanProgress, type PlanStepProgress, type TrackedProblem } from "@/src/core";

/**
 * The lesson-tracking card (owner, 2026-11-02): a floating panel in the
 * chat's top-right corner showing the cram problem set and the mistake log
 * (src/core/lesson-tracking.ts — derived from the record, so it follows the
 * tool calls live and survives reloads). The header chip toggles it; the
 * choice is remembered per device. Phone-width layouts start hidden.
 * Since 2026-11-05 (owner) it also carries a normal teach lesson's plan —
 * where the lesson is and each step's check score (src/core/plan-progress.ts).
 */

const STORAGE_KEY = "lh:lesson-tracker";
/** Tailwind's `sm` breakpoint: below it is a phone-width layout. */
const PHONE_QUERY = "(max-width: 639px)";

function isPhoneWidth(): boolean {
	try {
		return window.matchMedia?.(PHONE_QUERY).matches === true;
	} catch {
		return false;
	}
}

function readShown(): boolean | null {
	try {
		const saved = window.localStorage.getItem(STORAGE_KEY);
		return saved === "1" ? true : saved === "0" ? false : null;
	} catch {
		return null;
	}
}

function writeShown(shown: boolean): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, shown ? "1" : "0");
	} catch {
		/* Blocked storage: the choice holds for this page only. */
	}
}

/** Whether the card shows: the device's remembered choice (shown by
 *  default), except a phone-width layout always starts hidden. Resolved
 *  after mount (null until then) so the server render never guesses. */
export function useLessonTrackerShown(): { shown: boolean; toggle: () => void } {
	const [shown, setShown] = useState<boolean | null>(null);
	useEffect(() => {
		setShown(isPhoneWidth() ? false : (readShown() ?? true));
	}, []);
	const toggle = useCallback(() => {
		setShown((was) => {
			const next = !was;
			writeShown(next);
			return next;
		});
	}, []);
	return { shown: shown === true, toggle };
}

/**
 * Room for the card (owner, 2026-11-02 — "make room"): while the card
 * shows and the session area is wide enough for both, the transcript
 * column's right padding clears the card's lane, so the card sits in the
 * margin beside a narrower column instead of covering content. 18.25rem =
 * the card (w-64, 16rem) + its gap from the edge (right-3, 0.75rem) + the
 * column's own gutter (px-6, 1.5rem). "Wide enough" is a 64rem session
 * area: the lane plus a reading column as wide as the dock (46rem). Below
 * that the card overlays, as before. A container query on the session
 * area (not the viewport), so the sidebar's width counts; the classes
 * apply only while the card shows — hidden or absent changes nothing.
 *
 * The dock follows (owner, 2026-11-05): the question card, composer,
 * reading field, queued steers, setup/plan-accept bar and footer row centre
 * on the column, not the whole pane, so a question never slides under the
 * card. The dock block takes the column's own padding box at the same
 * breakpoint — the column's px-6 left (1.5rem) and its room-making right —
 * so the 46rem dock centres in exactly the column's content box.
 */
export const TRACKER_ROOM_AREA = "@container/session";
export const TRACKER_ROOM_COLUMN = "@min-[64rem]/session:pr-[18.25rem]";
export const TRACKER_ROOM_DOCK = "@min-[64rem]/session:pl-[1.5rem] @min-[64rem]/session:pr-[18.25rem]";

export function lessonTrackerRoom(active: boolean): { area: string; column: string; dock: string } {
	return active ? { area: TRACKER_ROOM_AREA, column: TRACKER_ROOM_COLUMN, dock: TRACKER_ROOM_DOCK } : { area: "", column: "", dock: "" };
}

/**
 * The plan diagram's height under the card's plan list, or null for no room
 * (the dock band's flank keeps it then): the card must have its own lane
 * (a 64rem session area) and PLAN_VIEW_MIN_H px free below its sections.
 */
export const PLAN_VIEW_MIN_AREA = 64 * 16;
export const PLAN_VIEW_MIN_H = 140;
export const PLAN_VIEW_MAX_H = 224;
/** The card's flex gap (gap-4) above the diagram. */
const SECTION_GAP = 16;

export function planViewHeight(areaWidth: number, cardMaxHeight: number, contentHeight: number): number | null {
	if (areaWidth < PLAN_VIEW_MIN_AREA || !Number.isFinite(cardMaxHeight)) return null;
	const room = Math.floor(cardMaxHeight - contentHeight - SECTION_GAP);
	return room >= PLAN_VIEW_MIN_H ? Math.min(room, PLAN_VIEW_MAX_H) : null;
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const CHIP =
	"lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide transition-colors";

/** The header chip beside Plan / Cram: toggles the card. */
export function LessonTrackerChip({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
	return (
		<Hint label={shown ? "Hide the progress card" : "Show the progress card"} side="bottom">
			<button
				type="button"
				data-testid="lesson-tracker-chip"
				aria-pressed={shown}
				onClick={(e) => {
					blurAfterPointerClick(e);
					onToggle();
				}}
				className={
					CHIP +
					" " +
					(shown
						? "border-border bg-accent text-foreground"
						: "border-border/80 text-muted-foreground hover:border-border hover:text-foreground")
				}
			>
				<ListChecksIcon className="size-3.5 text-primary" aria-hidden />
				Progress
			</button>
		</Hint>
	);
}

function SectionHeader({ title, count }: { title: string; count: string }) {
	return (
		<h3 className="mb-2 flex items-baseline justify-between gap-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
			<span>{title}</span>
			<span data-testid="lesson-tracker-count" className="tabular-nums normal-case">
				{count}
			</span>
		</h3>
	);
}

/** `statusLabel`: the status the aria-hidden symbol shows, for screen
 *  readers (visually hidden — sr-only is out of flow, so the row's layout
 *  is unchanged). */
function Row({ symbol, status, text, className, symbolClassName = "", aside, statusLabel }: { symbol: string; status: string; text: string; className: string; symbolClassName?: string; aside?: ReactNode; statusLabel?: string }) {
	return (
		<li data-status={status} className={`flex gap-2 leading-snug ${className}`}>
			<span aria-hidden data-testid="lesson-tracker-symbol" className={`w-3 shrink-0 text-center ${symbolClassName}`}>
				{symbol}
			</span>
			{statusLabel && <span className="sr-only">{`${statusLabel}: `}</span>}
			<span className="min-w-0 break-words">{text}</span>
			{aside}
		</li>
	);
}

/** One archived mistake: a single struck-through line; a tap, click or
 *  Enter/Space unfolds the full text (hover alone would leave touch and
 *  keyboard users with a cut-off line). */
function ResolvedMistake({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	return (
		<li data-status="resolved" className="text-[10.5px] leading-snug text-muted-foreground/60">
			<button
				type="button"
				aria-expanded={open}
				title={text}
				onClick={() => setOpen((o) => !o)}
				className="flex w-full cursor-pointer gap-2 rounded-sm text-left hover:text-muted-foreground focus-visible:outline-1 focus-visible:outline-ring"
			>
				<span aria-hidden data-testid="lesson-tracker-symbol" className="w-3 shrink-0 text-center text-green-500/60">✓</span>
				<span className={`min-w-0 line-through decoration-muted-foreground/60 ${open ? "break-words" : "truncate"}`}>{text}</span>
			</button>
		</li>
	);
}

/** Mistakes (owner, 2026-11-05): open ones first, full text with room to
 *  read; a resolved one is archived below them — one dimmed, smaller,
 *  struck-through line, the full text on hover. */
function MistakeList({ mistakes }: { mistakes: LessonTracking["mistakes"] }) {
	const open = mistakes.filter((m) => !m.resolved);
	const resolved = mistakes.filter((m) => m.resolved);
	return (
		<>
			{open.length > 0 && (
				<ul data-testid="lesson-tracker-open-mistakes" className="flex flex-col gap-2">
					{open.map((m) => (
						<Row key={m.id} symbol="○" status="open" text={m.text} className="leading-relaxed text-foreground" />
					))}
				</ul>
			)}
			{resolved.length > 0 && (
				<ul data-testid="lesson-tracker-resolved-mistakes" className={`flex flex-col gap-1 ${open.length > 0 ? "mt-2.5 border-t border-border/60 pt-2" : ""}`}>
					{resolved.map((m) => (
						<ResolvedMistake key={m.id} text={m.text} />
					))}
				</ul>
			)}
		</>
	);
}

/** One problem row (owner, 2026-11-03): ▸ + bold the current problem, then
 *  its latest outcome — the quiz feedback's green ✓ correct and red ✗
 *  incorrect (answered-card.tsx), a grey – skipped — else ○ not started. */
function ProblemRow({ problem: p }: { problem: TrackedProblem }) {
	if (p.current) return <Row symbol="▸" status="current" text={p.label} className="font-semibold text-foreground" />;
	switch (p.outcome) {
		case "correct":
			return <Row symbol="✓" status="correct" text={p.label} className="text-muted-foreground" symbolClassName="text-green-500" />;
		case "incorrect":
			return <Row symbol="✗" status="incorrect" text={p.label} className="text-muted-foreground" symbolClassName="text-red-500" />;
		case "skipped":
			return <Row symbol="–" status="skipped" text={p.label} className="text-muted-foreground" symbolClassName="text-muted-foreground" />;
		default:
			return <Row symbol="○" status="todo" text={p.label} className="text-muted-foreground" />;
	}
}

/** A plan step's check score (owner, 2026-11-05): right/answered,
 *  right-aligned — green when the step's latest answered check was right,
 *  red when wrong; nothing while the step has no graded check (an
 *  ungraded explain answer counts for nothing). The colour and the slash
 *  are visual only, so screen readers get the words instead (Codex round 1,
 *  2026-11-05): "1 of 2 checks right, latest wrong". */
const SCORE_TONE = { right: "text-green-500", wrong: "text-red-500" } as const;

function StepScore({ step }: { step: PlanStepProgress }) {
	if (step.answered === 0 || !step.latest) return null;
	return (
		<span
			data-testid="lesson-tracker-score"
			data-latest={step.latest}
			className={`ml-auto shrink-0 pl-1 font-normal tabular-nums ${SCORE_TONE[step.latest]}`}
		>
			<span aria-hidden>
				{step.right}/{step.answered}
			</span>
			<span className="sr-only">{`, ${step.right} of ${step.answered} ${step.answered === 1 ? "check" : "checks"} right, latest ${step.latest}`}</span>
		</span>
	);
}

/** One plan step (owner, 2026-11-05) in the problem rows' conventions:
 *  ▸ + bold the current step, a muted ✓ for a step moved past, ○ upcoming;
 *  each status also in words for screen readers (Codex round 1). */
function PlanStepRow({ step }: { step: PlanStepProgress }) {
	const score = <StepScore step={step} />;
	switch (step.status) {
		case "current":
			return <Row symbol="▸" status="current" statusLabel="Current step" text={step.title} className="font-semibold text-foreground" aside={score} />;
		case "visited":
			return <Row symbol="✓" status="covered" statusLabel="Covered" text={step.title} className="text-muted-foreground" aside={score} />;
		default:
			return <Row symbol="○" status="upcoming" statusLabel="Not started" text={step.title} className="text-muted-foreground" aside={score} />;
	}
}

/** "Practice weak spots" (owner, 2026-11-06): shown while the lesson has a
 *  red plan step or an open mistake (lessonWeakSpots). A failed start keeps
 *  the learner here with a retry. */
function PracticeWeakSpotsButton({ onStart }: { onStart: () => Promise<void> }) {
	const [state, setState] = useState<"idle" | "starting" | "failed">("idle");
	return (
		<div>
			<button
				type="button"
				data-testid="lesson-tracker-practice"
				disabled={state === "starting"}
				onClick={(e) => {
					blurAfterPointerClick(e);
					setState("starting");
					onStart().catch(() => setState("failed"));
				}}
				className="w-full cursor-pointer rounded-lg border border-border/80 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-60"
			>
				Practice weak spots
			</button>
			{state === "failed" && (
				<p role="alert" className="mt-1.5 text-[11px] text-muted-foreground">
					Couldn’t start the practice session. Try again.
				</p>
			)}
		</div>
	);
}

/**
 * The card: "Plan covered/total" (one PlanStepRow each) for a teach lesson
 * with a plan (`plan`, null in cram and practice), "Problems correct/total" (one ProblemRow each) when a list
 * exists, "Mistakes K open · J fixed" (○ open, archived ✓ resolved) when any mistake
 * exists — in that order. Height (owner, 2026-11-05: "why doesn't it get
 * longer"): while the area makes room (wide layouts) the dock sits left of the
 * card's lane, so the card may run the pane's full height; otherwise it stops
 * above the dock (`bottomReserve`: the dock's height, without its fade). A
 * longer card scrolls.
 */
export function LessonTrackerCard({ tracking, plan = null, bottomReserve, onPracticeWeakSpots, planView, onPlanViewPlaced, onOpenPlan }: {
	tracking: LessonTracking;
	plan?: PlanProgress | null;
	bottomReserve: number;
	/** Starts a practice session on the weak spots and opens it; absent = no button. */
	onPracticeWeakSpots?: (spots: string[]) => Promise<void>;
	/** A plan diagram to show under the Plan section if there is room. */
	planView?: ReactNode;
	/** Whether the card shows `planView` (false again on unmount). */
	onPlanViewPlaced?: (placed: boolean) => void;
	onOpenPlan?: () => void;
}) {
	const { problems, mistakes } = tracking;
	const openMistakes = mistakes.filter((m) => !m.resolved).length;
	const weakSpots = lessonWeakSpots(tracking, plan);
	const asideRef = useRef<HTMLElement | null>(null);
	const [viewHeight, setViewHeight] = useState<number | null>(null);
	const offersView = plan !== null && planView != null;
	useIsoLayoutEffect(() => {
		const aside = asideRef.current;
		if (!aside || !offersView) return;
		let shown: number | null = null;
		const measure = () => {
			const area = aside.offsetParent as HTMLElement | null;
			// The sections' height: the card's content without the diagram.
			const content = aside.scrollHeight - (shown === null ? 0 : shown + SECTION_GAP);
			// In its own lane (the only case with room) the card's max-height is
			// the area's height less 1.5rem, less its 1px borders.
			shown = planViewHeight(area?.clientWidth ?? 0, (area?.clientHeight ?? 0) - 24 - 2, content);
			setViewHeight(shown);
			onPlanViewPlaced?.(shown !== null);
		};
		measure();
		const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		ro?.observe(aside);
		if (aside.offsetParent) ro?.observe(aside.offsetParent);
		return () => {
			ro?.disconnect();
			setViewHeight(null);
			onPlanViewPlaced?.(false);
		};
	}, [offersView, onPlanViewPlaced]);
	return (
		<aside
			ref={asideRef}
			data-testid="lesson-tracker"
			aria-label="Lesson progress"
			className="absolute right-3 top-3 z-20 flex max-h-[calc(100%-var(--lh-card-reserve))] w-64 max-w-[calc(100%-1.5rem)] flex-col gap-4 overflow-y-auto rounded-xl border border-border/80 bg-card/95 px-3.5 py-3 font-ui text-xs text-foreground shadow-sm backdrop-blur-sm @min-[64rem]/session:max-h-[calc(100%-1.5rem)]"
			style={{ "--lh-card-reserve": `${bottomReserve + 24}px` } as CSSProperties}
		>
			{plan && (
				<section data-testid="lesson-tracker-plan">
					<SectionHeader title="Plan" count={`${plan.covered}/${plan.total}`} />
					<ul className="flex flex-col gap-1">
						{plan.steps.map((step) => (
							<PlanStepRow key={step.id} step={step} />
						))}
					</ul>
				</section>
			)}
			{plan && planView && viewHeight !== null && (
				<Hint label="Open the full plan" side="bottom">
					<button
						type="button"
						data-testid="plan-marginalia"
						data-placement="card"
						onClick={onOpenPlan}
						className="block w-full shrink-0 cursor-pointer"
						style={{ height: viewHeight }}
					>
						{planView}
					</button>
				</Hint>
			)}
			{problems && (
				<section data-testid="lesson-tracker-problems">
					<SectionHeader title="Problems" count={`${correctProblemCount(problems)}/${problems.length}`} />
					<ul className="flex flex-col gap-1">
						{problems.map((p) => (
							<ProblemRow key={p.id} problem={p} />
						))}
					</ul>
				</section>
			)}
			{mistakes.length > 0 && (
				<section data-testid="lesson-tracker-mistakes">
					<SectionHeader title="Mistakes" count={`${openMistakes} open${mistakes.length > openMistakes ? ` · ${mistakes.length - openMistakes} fixed` : ""}`} />
					<MistakeList mistakes={mistakes} />
				</section>
			)}
			{onPracticeWeakSpots && weakSpots.length > 0 && <PracticeWeakSpotsButton onStart={() => onPracticeWeakSpots(weakSpots)} />}
		</aside>
	);
}
