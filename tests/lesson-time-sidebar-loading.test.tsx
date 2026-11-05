/**
 * Time spent while the setting is still loading (owner, 2026-11-05; PR #41
 * review round 3): the server already has the switch on and this window's
 * first list carries the figures, but its first settings read has not come
 * back. A silent record write (a dismissal's record-changed) in that window
 * must still refresh the list, or the figure shows stale once the read lands.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import {
	chatStore,
	emit,
	figures,
	mountSidebar,
	seedLessons,
	served,
	serverFetch,
	settle,
	steps,
	writeSettings,
	MIN,
} from "./helpers/lesson-time-sidebar.tsx";

const timed = seedLessons();
writeSettings({ version: 1, general: { showLessonTime: true } });

it("a record change during the first settings read still refreshes the figure", async () => {
	let releaseSettings!: () => void;
	const settingsHeld = new Promise<void>((resolve) => (releaseSettings = resolve));
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		if (String(input) === "/api/settings") await settingsHeld;
		return serverFetch(input);
	}) as typeof fetch;
	await mountSidebar();
	await settle();
	assert.deepEqual(figures(), [], "nothing shows before the setting is known");
	const lists = served.lists;

	chatStore.saveMessages(timed.id, [...timed.lesson, ...steps(11, 2, 160 * MIN)]);
	await act(async () => emit("record-changed", { chatId: timed.id }));
	await settle();
	assert.equal(served.lists, lists + 1, "the write is not missed while loading");

	await act(async () => releaseSettings());
	await settle();
	assert.deepEqual(figures(), ["Time spent: 1h 50m"]);
});
