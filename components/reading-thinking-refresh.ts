"use client";

import { useState } from "react";
import { FACTORY_SETTINGS, type UserSettings } from "@/src/core";
import { useSettingsSaved } from "@/components/settings-signal";

/** Re-reads the reading-thinking preference after a models or general settings save.
 * A failed read keeps the current value and returns a short message until the next
 * successful read. */
export function useReadingThinkingRefresh(apply: (show: boolean) => void): string {
	const [error, setError] = useState("");
	useSettingsSaved((section) => {
		if (section !== "models" && section !== "general") return;
		fetch("/api/settings")
			.then((r) => (r.ok ? (r.json() as Promise<{ settings?: UserSettings | null }>) : Promise.reject()))
			.then((body) => {
				apply(body.settings?.general?.showReadingThinking ?? FACTORY_SETTINGS.general.showReadingThinking);
				setError("");
			})
			.catch(() => setError("Could not load your updated settings. Reload to apply them."));
	});
	return error;
}
