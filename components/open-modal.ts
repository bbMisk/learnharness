import { useEffect } from "react";
import { isComposing } from "@/components/ime";

/** The topmost open app modal (anything marked data-lh-modal): it owns the keyboard. */
export function openModal(): HTMLElement | null {
	if (typeof document === "undefined") return null;
	const all = document.querySelectorAll<HTMLElement>("[data-lh-modal]");
	return all[all.length - 1] ?? null;
}

/** While `active`, Esc closes this dialog. THE ONE-ESC LAW (keyboard round
 *  2026-10-06): the Esc is claimed at the document level, since a
 *  window-level stopPropagation cannot stop the earlier-registered global
 *  window listener; one an input method owns is left alone. `busy`: still
 *  claimed, but the dialog stays open (a delete in flight shows its
 *  failure). `capture`: the window's capture phase instead, before any
 *  layer under it sees the Esc at the document. */
export function useEscapeClose(active: boolean, onClose: () => void, { busy = false, capture = false } = {}): void {
	useEffect(() => {
		if (!active) return;
		const target = capture ? window : document;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented || isComposing(e)) return;
			e.preventDefault();
			e.stopPropagation();
			if (!busy) onClose();
		};
		target.addEventListener("keydown", onKeyDown as EventListener, capture);
		return () => target.removeEventListener("keydown", onKeyDown as EventListener, capture);
	}, [active, onClose, busy, capture]);
}
