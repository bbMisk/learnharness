"use client";

import { useEffect, useState } from "react";

/** Whatever held focus now, with its caret: the returned call hands both
 * back. Focus alone isn't enough once a backdrop click has moved the
 * selection out of a text field: the caret would land at its start. */
export function captureFocus(): ((preventScroll: boolean) => boolean) | null {
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
		if (!el.isConnected) return false;
		if (document.activeElement === el) return true; // it has focus again: keep its current caret
		el.focus({ preventScroll });
		if (field && start !== null && end !== null) {
			try { field.setSelectionRange(start, end); } catch { /* not a text-type input */ }
		}
		const selection = editable ? document.getSelection() : null;
		if (!selection) return true;
		if (range && el.contains(range.startContainer) && el.contains(range.endContainer)) {
			selection.removeAllRanges();
			selection.addRange(range);
		} else if (!(selection.rangeCount && el.contains(selection.getRangeAt(0).startContainer))) {
			selection.selectAllChildren(el);
			selection.collapseToEnd();
		}
		return true;
	};
}

/** The fields the page types into, first shown one wins: an open check
 * question's Your thinking (or answer), a practice problem's, the reading
 * note, then the composer. A collapsed check's dock is mounted but hidden. */
const TYPING_TARGETS = [
	'[data-testid="thinking-field"] [data-file-path-input]',
	'[data-testid="answer-field"] [data-file-path-input]',
	'[data-testid="practice-thinking-field"] [data-file-path-input]',
	'[data-testid="reading-thinking-field"] [data-file-path-input]',
	'[data-testid="composer"] [data-file-path-input]',
	"[data-file-path-default]",
];

/** The page's typing target, caret at the end of its draft: where focus goes
 * when nothing else should have it. Plain focus() would put the caret at the start. */
export function focusComposer(): void {
	const el = TYPING_TARGETS.map((target) => document.querySelector<HTMLElement>(target))
		.find((field) => field && (field.checkVisibility?.({ visibilityProperty: true }) ?? true));
	if (!el) return;
	const selection = el.isContentEditable ? document.getSelection() : null;
	const inside = !!selection?.rangeCount && el.contains(selection.getRangeAt(0).startContainer);
	el.focus();
	if (selection && !inside) {
		selection.selectAllChildren(el);
		selection.collapseToEnd();
	}
}

/** A dialog's focus return: captured at its first render (before it takes
 * focus) and handed back, caret included, when it closes. `fallback` runs
 * when nothing held focus on open (e.g. a deep link opened the dialog) or
 * what held it is gone. */
export function useFocusReturn(preventScroll = false, fallback?: () => void): void {
	const [restore] = useState(captureFocus);
	useEffect(() => () => { if (!restore?.(preventScroll)) fallback?.(); }, [restore, preventScroll, fallback]);
}
