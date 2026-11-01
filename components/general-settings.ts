"use client";

import { useEffect, useState } from "react";
import type { GeneralSettings, UserSettings } from "@/src/core";
import { onSettingsSaved } from "@/components/settings-signal";

/** The saved General settings, shared by every reader in the page: fetched on
 *  first use and again whenever the General section is saved (even with no
 *  reader mounted). Undefined until the first read lands. */
let general: GeneralSettings | undefined;
let loaded: Promise<void> | undefined;
const readers = new Set<() => void>();

function refresh(): Promise<void> {
	loaded = fetch("/api/settings")
		.then((r) => (r.ok ? (r.json() as Promise<{ settings?: UserSettings | null }>) : Promise.reject()))
		.then((body) => {
			general = body.settings?.general ?? {};
		})
		.catch(() => undefined)
		.then(() => readers.forEach((update) => update()));
	return loaded;
}

if (typeof window !== "undefined")
	onSettingsSaved((section) => {
		if (section === "general") void refresh();
	});

export function useGeneralSettings(): GeneralSettings | undefined {
	const [value, setValue] = useState(general);
	useEffect(() => {
		const update = () => setValue(general);
		readers.add(update);
		if (loaded) void loaded.then(update);
		else void refresh();
		return () => {
			readers.delete(update);
		};
	}, []);
	return value;
}
