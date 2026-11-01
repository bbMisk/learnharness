"use client";

import { useState } from "react";
import { visibleModes, type SessionMode } from "@/src/core";
import { useGeneralSettings } from "@/components/general-settings";

/** The modes offered (Settings → General → Session modes). */
export function useVisibleModes(): SessionMode[] {
	return visibleModes(useGeneralSettings()?.hiddenModes);
}

/** A new session's mode, never one the learner has hidden: a hidden choice
 *  (the default, or ?mode=practice) falls back to the first visible mode. */
export function useSessionMode(initial: SessionMode): [SessionMode, (mode: SessionMode) => void, SessionMode[]] {
	const modes = useVisibleModes();
	const [mode, setMode] = useState(initial);
	return [modes.includes(mode) ? mode : modes[0]!, setMode, modes];
}
