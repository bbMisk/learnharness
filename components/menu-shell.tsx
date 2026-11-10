"use client";

import { safeAreaInsets } from "@/components/safe-area";
export { safeAreaInsets };
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * The shared menu shell: one placement body for the app's dropdown menus —
 * portaled to document.body (never clipped by an ancestor's overflow),
 * fixed-anchored to the trigger's rect, viewport-capped. Placement only:
 * every site keeps its own open/close/Escape contract.
 *
 *  - Side: each site declares a preferred side (the composer opens up, the
 *    settings rows open down); the shell flips when the preferred side cannot
 *    show the content and the other side is roomier.
 *  - Cap: max-height = min(60vh, the chosen side's room), and max-width = the
 *    safe room on the side the menu extends toward; the menu scrolls
 *    internally instead of escaping the viewport.
 *  - Re-placement: capture-phase scroll (inner scrollers included), resize,
 *    and content that grows past the cap.
 *
 * SSR: menus only mount client-side while open; the hidden measuring pass
 * below is the only pre-placement render, so a server render never emits a
 * positioned menu.
 */

/** The narrowest a menu may get before it moves against the safe edge instead. */
const MIN_ROOM = 160;
const GAP = 4; // anchor edge → menu (the bespoke shells' settled 4px)
const EDGE = 8; // viewport floor the menu never enters
const CAP_VH = 0.6; // 60vh — the graph pattern's cap
const MIN_USABLE = 96; // floor: a shorter cap is an unusable sliver; the
// cap then overflows the edge instead of crushing the menu

/** A MenuShell mounted = a dropdown open. The shell only announces it;
 *  surfaces decide what to do (the settings dialog locks its content
 *  scroll; anything else keeps the re-place-on-scroll fallback below).
 *  Listeners count open/close, so overlapping menus stay balanced. */
export const MENU_OPEN_EVENT = "lh:menu-open";
export const MENU_CLOSE_EVENT = "lh:menu-close";

export type MenuSide = "up" | "down";
export type MenuAlign = "left" | "right";

/** One placement decision. `style` is the fixed-position payload; the side
 *  rides back for the flip assertion in tests. */
export interface MenuPlacement {
	side: MenuSide;
	style: Record<string, string | number>;
	maxHeight: number;
}

/** Pure: the placement decision — anchored rect + viewport + the menu's
 *  UNCAPPED content height (scrollHeight, so re-placements after a search
 *  filter re-measure honestly) → side, fixed style, cap. Flip rule: stay
 *  on the preferred side unless it cannot show the full content AND the
 *  other side is roomier. The cap always keeps the menu inside its side's
 *  room when there is room; the floor keeps it usable when there isn't. */
export function computeMenuPlacement(
	rect: { top: number; bottom: number; left: number; right: number },
	viewport: { width: number; height: number },
	contentHeight: number,
	preferredSide: MenuSide,
	align: MenuAlign,
	/** Safe-area insets (iPad Home Screen app, owner 2026-11-03): the status
	 *  bar and home indicator are not usable room. 0 on desktop/Electron. */
	safe: { top: number; bottom: number; left?: number; right?: number } = { top: 0, bottom: 0 },
): MenuPlacement {
	// An anchor left off-screen by a resize or rotation places from the edge it left by.
	const clampY = (y: number) => Math.min(Math.max(y, safe.top), viewport.height - safe.bottom);
	const clampX = (x: number) => Math.min(Math.max(x, safe.left ?? 0), viewport.width - (safe.right ?? 0));
	// Copy fields explicitly: a DOMRect keeps them as prototype getters, which spread drops.
	rect = { left: clampX(rect.left), right: clampX(rect.right), top: clampY(rect.top), bottom: clampY(rect.bottom) };
	const availDown = viewport.height - safe.bottom - EDGE - (rect.bottom + GAP);
	const availUp = rect.top - GAP - EDGE - safe.top;
	// contentHeight ≤ 0 (nothing measured yet) keeps the preferred side —
	// the hidden first pass re-measures and decides with real numbers.
	let side = preferredSide;
	if (contentHeight > 0) {
		const preferredAvail = preferredSide === "down" ? availDown : availUp;
		const otherAvail = preferredSide === "down" ? availUp : availDown;
		if (contentHeight > preferredAvail && otherAvail > preferredAvail) {
			side = preferredSide === "down" ? "up" : "down";
		}
	}
	const avail = side === "down" ? availDown : availUp;
	let maxHeight = Math.max(MIN_USABLE, Math.min(CAP_VH * viewport.height, avail));
	// With safe-area insets the usability floor must not push the menu into the
	// status bar or home indicator. Zero insets: unchanged.
	if (safe.top > 0 || safe.bottom > 0) {
		const safeRoom = side === "down" ? viewport.height - safe.bottom - (rect.bottom + GAP) : rect.top - GAP - safe.top;
		maxHeight = Math.max(0, Math.min(maxHeight, safeRoom));
	}
	// The menu may not grow past the (safe) edge on the side it extends toward
	// (iPhone landscape notch, an iPad split view). With less than MIN_ROOM there
	// (a node right-clicked near the window's edge), it sits against that safe
	// edge instead of shrinking to nothing.
	const room = align === "right" ? rect.right - (safe.left ?? 0) - EDGE : viewport.width - (safe.right ?? 0) - EDGE - rect.left;
	const horizontal: Record<string, number> =
		room >= MIN_ROOM
			? { ...(align === "right" ? { right: viewport.width - rect.right } : { left: rect.left }), maxWidth: room }
			: { ...(align === "right" ? { left: (safe.left ?? 0) + EDGE } : { right: (safe.right ?? 0) + EDGE }), maxWidth: viewport.width - (safe.left ?? 0) - (safe.right ?? 0) - 2 * EDGE };
	const vertical: Record<string, number> =
		side === "down" ? { top: rect.bottom + GAP } : { bottom: viewport.height - rect.top + GAP };
	return { side, style: { ...horizontal, ...vertical }, maxHeight };
}

/** The shared shell. Exactly one anchor seam: pass `anchorRef` (a live
 *  element ref) or `anchorTestid` (the settings section's pattern — the
 *  trigger is queried by testid at place time). */
/** A click that closes a menu may be the first of a double click: the
 *  second lands on whatever the menu covered (a chat row) or on a dialog
 *  the item opened. Swallow that tail (detail > 1) for a moment after. */
const DOUBLE_CLICK_TAIL_MS = 500;
function swallowDoubleClickTail() {
	const types = ["mousedown", "mouseup", "click", "dblclick"] as const;
	const stop = (event: MouseEvent) => {
		if (event.detail > 1) {
			event.preventDefault();
			event.stopPropagation();
		}
	};
	const target = window;
	for (const type of types) target.addEventListener(type, stop, true);
	setTimeout(() => {
		for (const type of types) target.removeEventListener(type, stop, true);
	}, DOUBLE_CLICK_TAIL_MS);
}

export function MenuShell({
	anchorRef,
	anchorTestid,
	testid,
	preferredSide,
	align = "right",
	menuClass,
	focusFirst = false,
	children,
}: {
	anchorRef?: RefObject<HTMLElement | null>;
	anchorTestid?: string;
	/** The menu body's own testid (sites assert it). */
	testid: string;
	/** Which way the menu opens from the anchor when both sides fit. */
	preferredSide: MenuSide;
	/** Which anchor edge the menu's horizontal position keys off. */
	align?: MenuAlign;
	/** The menu body classes: width, border, bg, padding, text — the
	 *  shell adds position, z-index, the height cap, and scrolling. */
	menuClass: string;
	/** Land focus on the first option (a menu opened from the keyboard), so Enter acts. */
	focusFirst?: boolean;
	children: ReactNode;
}) {
	const menuRef = useRef<HTMLDivElement>(null);
	const [placed, setPlaced] = useState<MenuPlacement | null>(null);
	const focusedOnceRef = useRef(false);

	// Announce open↔close for lockable surfaces (see MENU_OPEN_EVENT).
	useEffect(() => {
		window.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT));
		return () => {
			window.dispatchEvent(new CustomEvent(MENU_CLOSE_EVENT));
			swallowDoubleClickTail();
		};
	}, []);

	// Focus on open (owner, fix wave): the search menus land focus IN the
	// search; menus without one land it on the body (tabIndex -1 below) so
	// the arrow machine has a home. Once only — re-placements (scroll/
	// resize) must never steal focus back mid-walk. The lists' own mount
	// focus runs during the hidden measuring pass, where focus() silently
	// fails (visibility: hidden subtrees are not focusable) — this seam is
	// the one that actually lands.
	useEffect(() => {
		if (placed === null || focusedOnceRef.current) return;
		focusedOnceRef.current = true;
		const el = menuRef.current;
		if (!el) return;
		const input = el.querySelector<HTMLElement>("input");
		const first = focusFirst ? el.querySelector<HTMLElement>("button:not([disabled])") : null;
		(input ?? first ?? el).focus();
	}, [placed, focusFirst]);

	// The standard arrow machine for menus WITHOUT a search (owner: when a
	// dropdown is expanded, the arrow keys cycle the options and never
	// scroll the screen): ArrowDown/Up move DOM focus among the option
	// buttons with WRAP, Home/End hit the ends; Enter activates the
	// focused button natively. Search menus own their arrows inside the
	// input (their clamped-walk machine, 2026-09-17) — those events never
	// bubble here, and the input/textarea guard is belt-and-braces.
	const onBodyKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		const { key } = e;
		if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
		const buttons = Array.from(
			menuRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [],
		);
		if (buttons.length === 0) return;
		e.preventDefault();
		if (key === "Home") {
			buttons[0]?.focus();
			return;
		}
		if (key === "End") {
			buttons[buttons.length - 1]?.focus();
			return;
		}
		const delta = key === "ArrowDown" ? 1 : -1;
		const idx = buttons.findIndex((b) => b === document.activeElement);
		// From the body (nothing focused yet): ArrowDown enters at the FIRST
		// option, ArrowUp at the last — the native-select convention.
		const base = idx === -1 ? (delta > 0 ? -1 : 0) : idx;
		const next = (base + delta + buttons.length) % buttons.length;
		buttons[next]?.focus();
	};

	const anchor = () => {
		if (anchorRef) return anchorRef.current;
		if (anchorTestid !== undefined) return document.querySelector(`[data-testid="${anchorTestid}"]`);
		return null;
	};

	// Measure + (re)place: on mount, then on every capture-phase scroll and
	// resize (rAF-throttled). scrollHeight keeps the flip decision honest
	// after the content changes shape (a search filtering the list).
	useLayoutEffect(() => {
		let raf = 0;
		const place = () => {
			const el = anchor();
			if (!el || !menuRef.current) return;
			const p = computeMenuPlacement(
				el.getBoundingClientRect(),
				{ width: window.innerWidth, height: window.innerHeight },
				menuRef.current.scrollHeight,
				preferredSide,
				align,
				safeAreaInsets(),
			);
			setPlaced(p);
		};
		place();
		const rePlace = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(place);
		};
		window.addEventListener("scroll", rePlace, true);
		window.addEventListener("resize", rePlace);
		// Content that arrives after placement (the chat row's coverage) and no
		// longer fits re-decides the side. Growth only: a search narrowing the
		// list never moves the menu under the typing.
		const grown = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
			const el = menuRef.current;
			if (el && el.scrollHeight > el.clientHeight) rePlace();
		});
		if (menuRef.current) grown?.observe(menuRef.current, { childList: true, subtree: true, characterData: true });
		return () => {
			cancelAnimationFrame(raf);
			grown?.disconnect();
			window.removeEventListener("scroll", rePlace, true);
			window.removeEventListener("resize", rePlace);
		};
	}, [anchorRef, anchorTestid, preferredSide, align]);

	// First pass: mounted hidden at the viewport's top-left so the layout
	// effect can measure the real content height before anything is seen.
	// The menu is positioned ONCE and then only re-anchored — no flash.
	if (placed === null) {
		return createPortal(
			<div
				ref={menuRef}
				data-testid={testid}
				data-lh-menu=""
				style={{ position: "fixed", left: 0, top: 0, visibility: "hidden" }}
				className={menuClass}
			>
				{children}
			</div>,
			document.body,
		);
	}
	return createPortal(
		<div
			ref={menuRef}
			data-testid={testid}
			data-lh-menu=""
			tabIndex={-1}
			onKeyDown={onBodyKeyDown}
			style={{ position: "fixed", zIndex: 60, ...placed.style, maxHeight: placed.maxHeight, overflowY: "auto" }}
			// The body is the arrow machine's focus home (input-less menus
			// land focus here on open) — the focus STAYS, but the browser's
			// default blue ring around it must not draw (owner, polish
			// round). Arrow cycling moves DOM focus to the buttons, which
			// carry their own hover/highlight; the ring is pure noise.
			className={`${menuClass} outline-none`}
		>
			{children}
		</div>,
		document.body,
	);
}