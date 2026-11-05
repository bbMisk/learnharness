"use client";

import { useEffect, useState } from "react";
import type { GeneralSettings, UserSettings } from "@/src/core";
import { onSettingsSaved } from "@/components/settings-signal";
import { useOptionalServerEvent, useOptionalServerResync } from "@/components/server-events";

/** The saved General settings, shared by every reader in the page: fetched on
 *  first use and again whenever the General section is saved (even with no
 *  reader mounted). Undefined until the first read lands. Saves in another
 *  window arrive as the server's settings-changed event, and a reconnect may
 *  have missed one (owner, 2026-11-05: the sidebar's time spent follows a
 *  switch flipped in any window); every mounted reader hears them, so one
 *  event costs one read. Only the newest read lands. */
let general: GeneralSettings | undefined;
let loaded: Promise<void> | undefined;
let generation = 0;
let refreshQueued = false;
const readers = new Set<() => void>();

function refresh(): Promise<void> {
	const read = ++generation;
	loaded = fetch("/api/settings")
		.then((r) => (r.ok ? (r.json() as Promise<{ settings?: UserSettings | null }>) : Promise.reject()))
		.then((body) => {
			if (read === generation) general = body.settings?.general ?? {};
		})
		.catch(() => undefined)
		.then(() => readers.forEach((update) => update()));
	return loaded;
}

/** One read for every reader that hears the same event (the hub dispatches synchronously). */
function refreshOnce(): void {
	if (refreshQueued) return;
	refreshQueued = true;
	queueMicrotask(() => {
		refreshQueued = false;
		void refresh();
	});
}

if (typeof window !== "undefined")
	onSettingsSaved((section) => {
		if (section === "general") void refresh();
	});

export function useGeneralSettings(): GeneralSettings | undefined {
	const [value, setValue] = useState(general);
	useOptionalServerEvent("settings-changed", (p) => {
		if (p.section === "general") refreshOnce();
	});
	useOptionalServerResync(refreshOnce);
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
