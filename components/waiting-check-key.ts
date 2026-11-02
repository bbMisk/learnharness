/** Focused elements that handle Enter/Space themselves; the waiting-check shortcut leaves them alone. */
const OWN_KEY_CONTROLS =
	'button, summary, select, a[href], label, [role="button"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="radio"], [role="link"]';

type KeyLike = { key: string; altKey: boolean; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean };

/** Does this keydown open the waiting check (owner, 2026-10-06; Space added 2026-11-01)?
 *  Only the "dead" case: plain Enter or Space with focus on nothing that uses the key —
 *  not a typing surface, not a focused control. Shift+Space keeps scrolling up;
 *  Shift+Enter is left alone. */
export function opensWaitingCheck(e: KeyLike, target: Element | null): boolean {
	const enter = e.key === "Enter";
	const space = e.key === " ";
	if ((!enter && !space) || e.altKey) return false;
	if (enter && e.shiftKey && !e.metaKey && !e.ctrlKey) return false;
	if (space && (e.shiftKey || e.metaKey || e.ctrlKey)) return false;
	const t = target as HTMLElement | null;
	if (!t) return true;
	if (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range") return false;
	if (t.tagName === "TEXTAREA" || t.isContentEditable) return false;
	return !t.closest?.(OWN_KEY_CONTROLS);
}
