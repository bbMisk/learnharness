"use client";

/** The live safe-area insets (globals.css --lh-safe-*). 0 on desktop/Electron. */
export function safeAreaInsets(): { top: number; bottom: number; left: number; right: number } {
	// Zero when styles can't be read (non-browser hosts): the pre-safe-area placement.
	if (typeof getComputedStyle !== "function") return { top: 0, bottom: 0, left: 0, right: 0 };
	try {
		const css = getComputedStyle(document.documentElement);
		const px = (name: string) => Number.parseFloat(css.getPropertyValue?.(name) ?? "") || 0;
		return { top: px("--lh-safe-top"), bottom: px("--lh-safe-bottom"), left: px("--lh-safe-left"), right: px("--lh-safe-right") };
	} catch {
		return { top: 0, bottom: 0, left: 0, right: 0 };
	}
}
