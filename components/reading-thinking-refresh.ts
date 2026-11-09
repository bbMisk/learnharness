"use client";

import { useState } from "react";
import { FACTORY_SETTINGS } from "@/src/core";
import { useSettingsSaved } from "@/components/settings-signal";
import { readSettings } from "@/components/settings-read";

/** Re-reads the reading-thinking preference after a models or general settings save.
 * A failed read keeps the current value and returns a short message until the next
 * successful read. */
export function useReadingThinkingRefresh(apply: (show: boolean) => void): string {
	const [error, setError] = useState("");
	useSettingsSaved((section) => {
		if (section !== "models" && section !== "general") return;
		readSettings()
			.then((body) => {
				apply(body.settings?.general?.showReadingThinking ?? FACTORY_SETTINGS.general.showReadingThinking);
				setError("");
			})
			.catch(() => setError("Could not load your updated settings. Reload to apply them."));
	});
	return error;
}
