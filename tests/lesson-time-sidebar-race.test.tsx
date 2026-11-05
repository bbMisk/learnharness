/**
 * Time spent, the first-load race (owner, 2026-11-05; PR #41 review round
 * 2): a window opens while another window switches time spent on. Its first
 * list is served while the switch is still off (no figures in it), but its
 * first settings read already sees it on, and no settings-changed event
 * reaches it (the switch happened before it subscribed). The sidebar must
 * notice the list was fetched without time spent and fetch it again.
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
	writeSettings,
} from "./helpers/lesson-time-sidebar.tsx";

seedLessons();

it("a list fetched before the switch went on is fetched again once the settings read says on", async () => {
	let listServed!: () => void;
	const firstListDone = new Promise<void>((resolve) => (listServed = resolve));
	let first = true;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === "/api/settings" && first) await firstListDone; // the read lands after the list
		const response = await serverFetch(input);
		if (url === "/api/chats" && first) {
			first = false;
			writeSettings({ version: 1, general: { showLessonTime: true } }); // another window, no event here
			listServed();
		}
		return response;
	}) as typeof fetch;
	await mountSidebar();
	await settle();
	assert.ok(served.lists >= 2, "the list is fetched again");
	assert.deepEqual(figures(), ["Time spent: 1h 30m"]);
});

it("a settings read that says on while the server still says off refetches once, not in a loop", async () => {
	globalThis.fetch = serverFetch as typeof fetch;
	writeSettings({ version: 1, general: { showLessonTime: false } });
	const before = served.lists;
	// The window still believes "on" (its last read); the lists now come back without figures.
	chatStore.createChat("Another lesson");
	await act(async () => emit("chats-changed", {}));
	await settle(1000);
	assert.ok(served.lists - before <= 2, `bounded refetches (got ${served.lists - before})`);
});
