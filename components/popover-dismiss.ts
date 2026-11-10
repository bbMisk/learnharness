import { useEffect, type RefObject } from "react";
import { isComposing } from "@/components/ime";

/**
 * Close-on-dismissal for floating panels (graph chrome, 2026-09-17):
 * any pointerdown landing OUTSIDE the control's root closes it; Escape
 * closes it too. The root contains both the toggle button and the panel,
 * so clicks on the control's own button stay "inside" — its toggle keeps
 * working — while a click on a sibling chrome button counts as outside:
 * pointerdown closes the open panel first, then the sibling's click opens
 * its own. Two dropdowns can therefore never be open at once.
 *
 * `inside`: presses on what matches it count as inside too (a menu body
 * portaled out of the root: without it a row's pointerdown eats the pick).
 * `onEscape`: what Esc does instead of `close` (e.g. hand focus back).
 * `captureEsc`: hear Esc in the document's capture phase.
 */
export function usePopoverDismiss(
	rootRef: RefObject<HTMLElement | null>,
	open: boolean,
	close: () => void,
	{ inside, onEscape, captureEsc = false }: { inside?: string; onEscape?: () => void; captureEsc?: boolean } = {},
): void {
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (inside && e.target instanceof Element && e.target.closest(inside)) return;
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !e.defaultPrevented && !isComposing(e)) {
				// Claim the Esc (keyboard wave A): the window-level dismiss
				// chain must not ALSO stop dictation / abort a turn under
				// this popover. Popovers are the chain's topmost layer.
				e.preventDefault();
				e.stopPropagation();
				(onEscape ?? close)();
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown, captureEsc);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown, captureEsc);
		};
	}, [open, close, rootRef, inside, onEscape, captureEsc]);
}
