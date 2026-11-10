"use client";

import { useEffect } from "react";

/** A click that closes a menu or dialog may be the first of a double click:
 *  the second lands on whatever it covered (a chat row) or on a dialog the
 *  item opened. Swallow that tail (detail > 1) for a moment after. */
const DOUBLE_CLICK_TAIL_MS = 500;
export function swallowDoubleClickTail() {
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

/** Controls that change under the pointer (an armed confirm, Send → Stop, the
 *  next row sliding in) must never take the second click of a double click.
 *  No control in the app gives a double click its own meaning, so drop that
 *  click app-wide, in capture, before any handler sees it. Plain text keeps
 *  its double-click selection, and `dblclick` itself (the panel resize handle)
 *  is untouched. */
const CONTROL = "button, a[href], summary, [role=button], [role=menuitem], [role=option], [role=tab], [role=switch], [role=checkbox]";
export function useDoubleClickGuard() {
	useEffect(() => {
		const stop = (event: MouseEvent) => {
			if (event.detail > 1 && event.target instanceof Element && event.target.closest(CONTROL)) {
				event.preventDefault();
				event.stopPropagation();
			}
		};
		window.addEventListener("click", stop, true);
		return () => window.removeEventListener("click", stop, true);
	}, []);
}
