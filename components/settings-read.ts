"use client";

import type { UserSettings } from "@/src/core";

export type SettingsBody = { settings?: UserSettings | null };

let shared: Promise<SettingsBody> | null = null;

/** GET /api/settings for the readers that mount together (opening a chat
 *  mounted several, each with its own request). Reads started in one
 *  synchronous run (a commit's effects, one event's listeners) share one
 *  request; any later read starts a fresh one, so a read after a save never
 *  sees older data. Rejects on a non-2xx status. */
export function readSettings(): Promise<SettingsBody> {
	if (shared) return shared;
	const read = fetch("/api/settings").then((r) =>
		r.ok ? (r.json() as Promise<SettingsBody>) : Promise.reject(new Error(`settings read failed: ${r.status}`)),
	);
	shared = read;
	queueMicrotask(() => {
		shared = null;
	});
	return read;
}
