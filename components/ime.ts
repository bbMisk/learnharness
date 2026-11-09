import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** A keydown an input method owns, such as the Enter that confirms a
 *  Japanese or Chinese candidate: a field must not act on it. */
export function isComposing(e: KeyboardEvent | ReactKeyboardEvent): boolean {
	return ("nativeEvent" in e ? e.nativeEvent.isComposing : e.isComposing) || e.keyCode === 229;
}
