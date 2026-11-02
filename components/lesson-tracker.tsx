"use client";

import { useCallback, useEffect, useState } from "react";
import { ListChecksIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import type { LessonTracking } from "@/src/core";

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
		<h3 className="mb-1.5 flex items-baseline justify-between gap-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
			<span>{title}</span>
			<span data-testid="lesson-tracker-count" className="tabular-nums normal-case">
				{count}
			</span>
		</h3>
	);
}

function Row({ symbol, status, text, className }: { symbol: string; status: string; text: string; className: string }) {
	return (
		<li data-status={status} className={`flex gap-2 leading-snug ${className}`}>
			<span aria-hidden className="w-3 shrink-0 text-center">
				{symbol}
			</span>
			<span className="min-w-0 break-words">{text}</span>
		</li>
	);
}

/**
 * The card: "Problems N/M" (✓ done, ▸ the first not-done, ○ the rest) when
 * a list exists, "Mistakes K open" (○ open, ✓ resolved) when any mistake
 * exists. `bottomReserve` is the dock's height — the card never reaches the
 * composer; it scrolls instead.
 */
export function LessonTrackerCard({ tracking, bottomReserve }: { tracking: LessonTracking; bottomReserve: number }) {
	const { problems, mistakes } = tracking;
	const firstOpen = problems?.findIndex((p) => !p.done) ?? -1;
	const openMistakes = mistakes.filter((m) => !m.resolved).length;
	return (
		<aside
			data-testid="lesson-tracker"
			aria-label="Lesson progress"
			className="absolute right-3 top-3 z-20 flex w-64 max-w-[calc(100%-1.5rem)] flex-col gap-3 overflow-y-auto rounded-xl border border-border/80 bg-card/95 p-3 font-ui text-xs text-foreground shadow-sm backdrop-blur-sm"
			style={{ maxHeight: `calc(100% - ${bottomReserve + 24}px)` }}
		>
			{problems && (
				<section data-testid="lesson-tracker-problems">
					<SectionHeader title="Problems" count={`${problems.filter((p) => p.done).length}/${problems.length}`} />
					<ul className="flex flex-col gap-1">
						{problems.map((p, i) =>
							p.done ? (
								<Row key={p.id} symbol="✓" status="done" text={p.label} className="text-muted-foreground" />
							) : i === firstOpen ? (
								<Row key={p.id} symbol="▸" status="current" text={p.label} className="font-medium text-foreground" />
							) : (
								<Row key={p.id} symbol="○" status="todo" text={p.label} className="text-muted-foreground" />
							),
						)}
					</ul>
				</section>
			)}
			{mistakes.length > 0 && (
				<section data-testid="lesson-tracker-mistakes">
					<SectionHeader title="Mistakes" count={`${openMistakes} open`} />
					<ul className="flex flex-col gap-1">
						{mistakes.map((m) =>
							m.resolved ? (
								<Row key={m.id} symbol="✓" status="resolved" text={m.text} className="text-muted-foreground" />
							) : (
								<Row key={m.id} symbol="○" status="open" text={m.text} className="text-foreground" />
							),
						)}
					</ul>
				</section>
			)}
		</aside>
	);
}
