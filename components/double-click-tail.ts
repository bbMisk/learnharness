"use client";

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
