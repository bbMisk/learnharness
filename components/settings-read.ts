"use client";

import type { ChatSettings, UserSettings } from "@/src/core";
import { sharedRead } from "@/components/shared-read";

export type SettingsBody = { settings?: UserSettings | null };

/** GET /api/settings, shared (sharedRead) by the readers that mount together:
 *  opening a chat mounted several, each with its own request. Rejects on a
 *  non-2xx status. */
export function readSettings(): Promise<SettingsBody> {
	return sharedRead("/api/settings", () => fetch("/api/settings").then((r) =>
		r.ok ? (r.json() as Promise<SettingsBody>) : Promise.reject(new Error(`settings read failed: ${r.status}`)),
	));
}

/** GET /api/chats/:id/settings, shared the same way: the model pills and
 *  the question-type chip mount together and each read it. */
export function readChatSettings(chatId: string): Promise<{ settings?: ChatSettings }> {
	const url = `/api/chats/${chatId}/settings`;
	return sharedRead(url, () => fetch(url, { cache: "no-store" }).then((r) =>
		r.ok ? (r.json() as Promise<{ settings?: ChatSettings }>) : Promise.reject(new Error(`settings read failed: ${r.status}`)),
	));
}
