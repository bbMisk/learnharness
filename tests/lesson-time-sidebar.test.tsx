/**
 * Time spent in the real sidebar (owner, 2026-11-05): the mounted app shell
 * against the real chat-list and settings routes, with the events channel
 * fed by the server's own bus (tests/helpers/lesson-time-sidebar.tsx). Off
 * by default the rows show no figure; switching it on in Settings → General
 * — in this window or another, or while disconnected — brings the figure in
 * without a reload; a silent record write (a dismissal) updates it; off
 * takes it away.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import {
	channel,
	chatStore,
	emit,
	figures,
	mountSidebar,
	rowsText,
	seedLessons,
	served,
	setGeneral,
	settle,
	steps,
	writeSettings,
	MIN,
} from "./helpers/lesson-time-sidebar.tsx";

const timed = seedLessons();

it("off by default: no figure on any row", async () => {
	await mountSidebar();
	await settle();
	assert.equal(rowsText().length, 2, "both lessons are listed");
	assert.deepEqual(figures(), []);
	assert.ok(!rowsText().some((text) => text.includes("1h 30m")));
});

it("switching on in this window shows the figure without a reload; off takes it away", async () => {
	const before = served.lists;
	await setGeneral({ showLessonTime: true }, true);
	await settle();
	assert.ok(served.lists > before, "switching on refetches the list");
	assert.deepEqual(figures(), ["Time spent: 1h 30m"], "the empty lesson shows nothing");
	await setGeneral({ showLessonTime: false }, true);
	await settle();
	assert.deepEqual(figures(), []);
});

it("follows the switch flipped in another window (the server's settings-changed event)", async () => {
	const reads = served.settingsReads;
	await setGeneral({ showLessonTime: true }, false);
	await settle();
	assert.deepEqual(figures(), ["Time spent: 1h 30m"]);
	assert.equal(served.settingsReads, reads + 1, "every General reader hears the event; one read serves them all");
	// Another General change while on: the list already carries the figures, so no list fetch.
	const lists = served.lists;
	await setGeneral({ showLessonTime: true, cramShortProbe: false }, false);
	await settle();
	assert.equal(served.lists, lists);
	assert.deepEqual(figures(), ["Time spent: 1h 30m"]);
	await setGeneral({ showLessonTime: false }, false);
	await settle();
	assert.deepEqual(figures(), []);
});

it("catches a switch flipped while disconnected on the reconnect", async () => {
	writeSettings({ version: 1, general: { showLessonTime: true } }); // no event reaches this window
	await settle();
	assert.deepEqual(figures(), [], "nothing told this window yet");
	await act(async () => channel.reopen!());
	await settle();
	assert.deepEqual(figures(), ["Time spent: 1h 30m"]);
});

it("a silent record write (a dismissal's record-changed) updates the figure", async () => {
	const before = served.lists;
	chatStore.saveMessages(timed.id, [...timed.lesson, ...steps(11, 2, 160 * MIN)]);
	await act(async () => emit("record-changed", { chatId: timed.id }));
	await settle();
	assert.equal(served.lists, before + 1, "one debounced list fetch");
	assert.deepEqual(figures(), ["Time spent: 1h 50m"]);
});

it("with the switch off, record-changed costs no list fetch", async () => {
	await setGeneral({ showLessonTime: false }, false);
	await settle();
	assert.deepEqual(figures(), []);
	const before = served.lists;
	await act(async () => emit("record-changed", { chatId: timed.id }));
	await settle();
	assert.equal(served.lists, before);
});
