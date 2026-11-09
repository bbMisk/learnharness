"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useStickToBottomContext, type StickToBottomContext } from "use-stick-to-bottom";
import { messageAnchorId, messageIdFromHash } from "@/src/core";

export type SessionScrollContext = Pick<StickToBottomContext, "scrollRef" | "stopScroll">;

/** Scroll only the session's own containers (including tall question/code
 * areas), never sidebar/chrome. Inner containers move first, then the main
 * transcript. stopScroll releases the sticky-bottom animation BEFORE jumping. */
export function scrollSessionTarget(target: Range | HTMLElement, scope: HTMLElement, context: SessionScrollContext | null): void {
	const node = "startContainer" in target ? target.startContainer : target;
	const main = context?.scrollRef.current;
	if (main?.contains(node)) context!.stopScroll();
	for (let element = node.parentElement; element && scope.contains(element); element = element.parentElement) {
		const view = element.ownerDocument.defaultView;
		const style = typeof view?.getComputedStyle === "function" ? view.getComputedStyle(element) : null;
		if (element !== main && (!style || !/(auto|scroll)/.test(style.overflowY) || element.scrollHeight <= element.clientHeight)) continue;
		const rect = target.getBoundingClientRect();
		const container = element.getBoundingClientRect();
		element.scrollTo({ top: element.scrollTop + rect.top - container.top - 16, behavior: "instant" });
	}
}

/** Reading positions for this window, by page: coming back to a chat returns
 * to where you were reading, not its bottom. A position is the transcript
 * row at the top of the view, counted from the end (older history fills in
 * above, and the dock's spacer below changes height), and its offset. */
interface ReadingPosition {
	fromEnd: number;
	offset: number;
	/** Further from the bottom than the dock's spacer: the passage survives
	 *  the question starting folded (a folded dock reserves less room, so a
	 *  position inside that band would clamp to the bottom). */
	clearOfDock: boolean;
}
const readingPositions = new Map<string, ReadingPosition>();
/** Closer to the bottom than this counts as following the bottom. */
const AT_BOTTOM_PX = 80;
/** Long enough for a big chat's history to fill in; any input ends it sooner. */
const RESTORE_MS = 4_000;
const INPUTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

function transcriptRows(scroller: HTMLElement): HTMLCollection | null {
	return scroller.querySelector("[data-session-find-root]")?.children ?? null;
}

/** The first row still showing at the top of the view (rows run top-down). */
function topRow(scroller: HTMLElement): ReadingPosition | null {
	const rows = transcriptRows(scroller);
	if (!rows?.length) return null;
	const viewTop = scroller.getBoundingClientRect().top;
	let lo = 0;
	let hi = rows.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (rows[mid]!.getBoundingClientRect().bottom > viewTop) hi = mid;
		else lo = mid + 1;
	}
	const fromBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
	const dock = scroller.querySelector<HTMLElement>('[data-testid="dock-spacer"]')?.offsetHeight ?? 0;
	return { fromEnd: rows.length - 1 - lo, offset: rows[lo]!.getBoundingClientRect().top - viewTop, clearOfDock: fromBottom > dock };
}

/** True while this page will return to a saved reading position (above the
 * bottom), so a question arriving with it starts folded instead of covering it. */
export function restoresReadingPosition(): boolean {
	return typeof window !== "undefined" && !window.location.hash && readingPositions.get(window.location.pathname)?.clearOfDock === true;
}

export function useReadingPosition(contextRef: RefObject<StickToBottomContext>): void {
	useEffect(() => {
		const key = window.location.pathname;
		const saved = window.location.hash ? undefined : readingPositions.get(key);
		let restoring = saved !== undefined;
		let scroller: HTMLElement | null = null;
		let position: ReadingPosition | null = null;
		const started = Date.now();
		const stopRestoring = () => { restoring = false; };
		const measure = () => {
			if (restoring || !scroller) return;
			const fromBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
			position = fromBottom > AT_BOTTOM_PX ? topRow(scroller) : null;
		};
		for (const type of INPUTS) window.addEventListener(type, stopRestoring, { capture: true, passive: true });
		// The scroller's ref lands after this effect (see the note below).
		const id = window.setInterval(() => {
			if (!scroller) {
				scroller = contextRef.current.scrollRef.current;
				if (!scroller) return;
				scroller.addEventListener("scroll", measure, { passive: true });
			}
			if (restoring && Date.now() - started < RESTORE_MS) {
				const rows = transcriptRows(scroller);
				const row = rows && rows.length > saved!.fromEnd ? rows[rows.length - 1 - saved!.fromEnd]! : null;
				const delta = row ? row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved!.offset : 0;
				if (Math.abs(delta) > 1) {
					contextRef.current.stopScroll();
					scroller.scrollTop += delta;
				}
				return;
			}
			restoring = false;
			window.clearInterval(id);
			measure();
		}, 64);
		return () => {
			window.clearInterval(id);
			for (const type of INPUTS) window.removeEventListener(type, stopRestoring, { capture: true });
			scroller?.removeEventListener("scroll", measure);
			// Left mid-restore: the saved position still stands.
			if (restoring) return;
			if (position) readingPositions.set(key, position);
			else readingPositions.delete(key);
		};
	}, [contextRef]);
}

/** React owns message markup; this controller adds no messages or content.
 * Arrival on a full load is the browser's own hash scroll; this watcher owns
 * SPA arrivals (graph links) and later hash changes. The mount path polls on
 * a short interval ON PURPOSE: the transcript scroller's ref is attached by a
 * LATER SIBLING (StickToBottom.Content), hydration orderings vary, and a
 * frame-chained rAF proved cancellable mid-flight in dev (the owner's
 * every-link-lands-at-bottom report, 2026-10-13) — a synchronous tick that
 * retries until both elements exist has no cancellation window. */
export function SessionMessageNavigation() {
	const context = useStickToBottomContext();
	// ABSORB IDENTITY CHURN (the 2026-10-13 heisenbug): use-stick-to-bottom
	// re-creates stopScroll (and thus this context) while its initial scroll
	// settles. Reading it through a ref keeps `jump`'s identity STABLE, so the
	// effects below run once — a dep-churned cleanup used to cancel the queued
	// jump / strip the flash mid-flight, which is exactly the owner's
	// every-link-lands-at-bottom report (it only reproduced WITHOUT debug
	// logging shifting the timing).
	const contextRef = useRef(context);
	contextRef.current = context;
	useReadingPosition(contextRef);
	const lastJump = useRef<{ hash: string; target: HTMLElement } | null>(null);
	const flash = useRef<{ target: HTMLElement; timer: number } | null>(null);
	const clearFlash = useCallback(() => {
		if (!flash.current) return;
		window.clearTimeout(flash.current.timer);
		flash.current.target.classList.remove("lh-source-highlight");
		flash.current = null;
	}, []);
	/** Synchronous arrival: release the bottom-follow lock, scroll every
	 * session container so the passage sits near the top, flash it. Returns
	 * true when this hash is (now) jumped-to. */
	const jump = useCallback((): boolean => {
		const { scrollRef, stopScroll } = contextRef.current;
		const hash = window.location.hash;
		const messageId = messageIdFromHash(hash);
		const main = scrollRef.current;
		const target = messageId ? document.getElementById(messageAnchorId(messageId)) : null;
		if (!main || !target || !main.contains(target)) return false;
		if (lastJump.current?.hash === hash && lastJump.current.target === target) return true;
		stopScroll();
		scrollSessionTarget(target, main, { scrollRef, stopScroll });
		clearFlash();
		target.classList.add("lh-source-highlight");
		flash.current = { target, timer: window.setTimeout(clearFlash, 2_000) };
		lastJump.current = { hash, target };
		return true;
	}, [clearFlash]);

	// Arrival on mount (a graph link opened this session, or a full load
	// carried the hash): retry on a short interval until the scroller and the
	// anchor both exist, then stop. The ~4s watchdog covers a never-arriving
	// anchor (a deleted message) — the session simply opens where it opens.
	useEffect(() => {
		if (!window.location.hash) return;
		let ticks = 0;
		const id = window.setInterval(() => {
			// Keep watching PAST the first success: hydration / record adoption
			// can REPLACE the node that was just jumped to (observed on cold
			// dev loads, 2026-10-13) — jump() re-targets the fresh node and
			// re-flashes it, while steady-state ticks are no-ops via the
			// lastJump guard. ~20s watchdog covers a cold compile (observed
			// 6.8s SSR flush) or slow first load; a deleted-message anchor
			// gives up and the session opens as-is.
			if (++ticks > 300) window.clearInterval(id);
			else jump();
		}, 64);
		return () => window.clearInterval(id);
	}, [jump]);

	useEffect(() => {
		const onHash = () => {
			lastJump.current = null;
			clearFlash();
			jump();
		};
		window.addEventListener("hashchange", onHash);
		window.addEventListener("popstate", onHash);
		// Cleanup removes LISTENERS ONLY: never clearFlash/lastJump here — a
	// dep-churned re-run must not strip a live flash (see the note above).
		return () => {
			window.removeEventListener("hashchange", onHash);
			window.removeEventListener("popstate", onHash);
		};
	}, [jump, clearFlash]);
	return null;
}
