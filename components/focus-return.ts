"use client";

import { useEffect, useState } from "react";

/** Whatever held focus now, with its caret: the returned call hands both
 * back. Focus alone isn't enough once a backdrop click has moved the
 * selection out of a text field: the caret would land at its start. */
export function captureFocus(): ((preventScroll: boolean) => void) | null {
	if (typeof document === "undefined") return null;
	const el = document.activeElement as HTMLElement | null;
	if (!el || el === document.body || typeof el.focus !== "function") return null;
	const field = el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? (el as HTMLInputElement) : null;
	const start = field?.selectionStart ?? null;
	const end = field?.selectionEnd ?? null;
	const editable = !field && el.isContentEditable === true;
	const live = editable ? document.getSelection() : null;
	const range = live?.rangeCount && el.contains(live.getRangeAt(0).startContainer) ? live.getRangeAt(0).cloneRange() : null;
	return (preventScroll) => {
		if (!el.isConnected) return;
		el.focus({ preventScroll });
		if (field && start !== null && end !== null) {
			try { field.setSelectionRange(start, end); } catch { /* not a text-type input */ }
		}
		const selection = editable ? document.getSelection() : null;
		if (!selection) return;
		if (range && el.contains(range.startContainer) && el.contains(range.endContainer)) {
			selection.removeAllRanges();
			selection.addRange(range);
		} else if (!(selection.rangeCount && el.contains(selection.getRangeAt(0).startContainer))) {
			selection.selectAllChildren(el);
			selection.collapseToEnd();
		}
	};
}

/** A dialog's focus return: captured at its first render (before it takes
 * focus) and handed back, caret included, when it closes. `fallback` runs
 * when nothing held focus on open (e.g. a deep link opened the dialog). */
export function useFocusReturn(preventScroll = false, fallback?: () => void): void {
	const [restore] = useState(captureFocus);
	useEffect(() => () => (restore ? restore(preventScroll) : fallback?.()), [restore, preventScroll, fallback]);
}
