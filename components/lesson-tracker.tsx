"use client";

import { useCallback, useEffect, useState } from "react";
import { ListChecksIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { correctProblemCount, type LessonTracking, type TrackedProblem } from "@/src/core";

/**
 * The lesson-tracking card (owner, 2026-11-02): a floating panel in the
 * chat's top-right corner showing the cram problem set and the mistake log
 * (src/core/lesson-tracking.ts — derived from the record, so it follows the
 * tool calls live and survives reloads). The header chip toggles it; the
 * choice is remembered per device. Phone-width layouts start hidden.
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
 * area (not the viewport), so the sidebar's width counts; both classes
 * apply only while the card shows — hidden or absent changes nothing.
 */
export const TRACKER_ROOM_AREA = "@container/session";
export const TRACKER_ROOM_COLUMN = "@min-[64rem]/session:pr-[18.25rem]";

export function lessonTrackerRoom(active: boolean): { area: string; column: string } {
	return active ? { area: TRACKER_ROOM_AREA, column: TRACKER_ROOM_COLUMN } : { area: "", column: "" };
}

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

function Row({ symbol, status, text, className, symbolClassName = "", textClassName = "break-words" }: { symbol: string; status: string; text: string; className: string; symbolClassName?: string; textClassName?: string }) {
	return (
		<li data-status={status} className={`flex gap-2 leading-snug ${className}`}>
			<span aria-hidden data-testid="lesson-tracker-symbol" className={`w-3 shrink-0 text-center ${symbolClassName}`}>
				{symbol}
			</span>
			<span className={`min-w-0 ${textClassName}`}>{text}</span>
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
						<li key={m.id} data-status="resolved" title={m.text} className="flex gap-2 text-[10.5px] leading-snug text-muted-foreground/60">
							<span aria-hidden data-testid="lesson-tracker-symbol" className="w-3 shrink-0 text-center text-green-500/60">✓</span>
							<span className="min-w-0 truncate line-through decoration-muted-foreground/60">{m.text}</span>
						</li>
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

/**
 * The card: "Problems correct/total" (one ProblemRow each) when a list
 * exists, "Mistakes K open · J fixed" (○ open, archived ✓ resolved) when any mistake
 * exists. `bottomReserve` is the dock's height — the card never reaches the
 * composer; it scrolls instead.
 */
export function LessonTrackerCard({ tracking, bottomReserve }: { tracking: LessonTracking; bottomReserve: number }) {
	const { problems, mistakes } = tracking;
	const openMistakes = mistakes.filter((m) => !m.resolved).length;
	return (
		<aside
			data-testid="lesson-tracker"
			aria-label="Lesson progress"
			className="absolute right-3 top-3 z-20 flex w-64 max-w-[calc(100%-1.5rem)] flex-col gap-4 overflow-y-auto rounded-xl border border-border/80 bg-card/95 px-3.5 py-3 font-ui text-xs text-foreground shadow-sm backdrop-blur-sm"
			style={{ maxHeight: `calc(100% - ${bottomReserve + 24}px)` }}
		>
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
		</aside>
	);
}
