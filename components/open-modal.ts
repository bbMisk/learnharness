/** The topmost open app modal (anything marked data-lh-modal): it owns the keyboard. */
export function openModal(): HTMLElement | null {
	if (typeof document === "undefined") return null;
	const all = document.querySelectorAll<HTMLElement>("[data-lh-modal]");
	return all[all.length - 1] ?? null;
}
