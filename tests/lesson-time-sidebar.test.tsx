/**
 * Time spent in the real sidebar (owner, 2026-11-05): the mounted app shell
 * against the real chat-list and settings routes (temp data dir), with the
 * events channel fed by the server's own bus. Off by default the rows show
 * no figure; switching it on in Settings → General — in this window or
 * another, or while disconnected — brings the figure in without a reload;
 * a silent record write (a dismissal) updates it; off takes it away.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lesson-time-sidebar-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.mkdirSync(process.env.LH_DATA_DIR, { recursive: true });

const dom = parseHTML("<!doctype html><html><body></body></html>");
const storage = new Map<string, string>([["lh:sidebar-open", "1"]]);
Object.assign(dom.window, { innerWidth: 1400, innerHeight: 900 });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	Event: dom.window.Event,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	self: globalThis,
	localStorage: {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
	},
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, {
	localStorage: (globalThis as { localStorage: unknown }).localStorage,
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
Object.assign(dom.document, { oninput: null });

const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
const { createRoot } = await import("react-dom/client");
const { AppShell, SidebarProvider } = await import("../components/sidebar.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { EVENT_REFRESH_MS } = await import("../components/chat-list-refresh.ts");
const { notifySettingsSaved } = await import("../components/settings-signal.ts");
const { emit, subscribe } = await import("../src/core/events.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");
const listing = await import("../app/api/chats/route.ts");
const settingsRoute = await import("../app/api/settings/route.ts");
const settingsSection = await import("../app/api/settings/[section]/route.ts");
import type { LhMessage } from "../src/core/native-messages.ts";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
/** The events channel, fed by the server's bus (what /api/events streams). */
let reopen: (() => void) | undefined;
const busChannel = () => {
	const handlers = new Map<string, (raw: string) => void>();
	const off = subscribe(({ type, ...payload }) => handlers.get(type)?.(JSON.stringify(payload)));
	return {
		close: () => void off(),
		onOpen: (cb: () => void) => void (reopen = cb),
		onEvent: (name: string, cb: (raw: string) => void) => void handlers.set(name, cb),
	};
};
const realFetch = globalThis.fetch;
let root: Root | undefined;
after(async () => {
	await act(async () => root?.unmount());
	globalThis.fetch = realFetch;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const listFetches: string[] = [];
let settingsReads = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
	const url = String(input);
	if (url === "/api/chats") {
		listFetches.push(url);
		return listing.GET(new Request("http://test/api/chats"));
	}
	if (url === "/api/settings") {
		settingsReads++;
		return settingsRoute.GET();
	}
	return new Response("{}", { status: 404 });
}) as typeof fetch;

/** Save the General section through the real route (it emits settings-changed).
 *  `here`: this window saved it, so its settings dialog also signals locally. */
async function setGeneral(general: Record<string, unknown>, here: boolean) {
	await act(async () => {
		const response = await settingsSection.PUT(
			new Request("http://test/api/settings/general", { method: "PUT", body: JSON.stringify(general) }),
			{ params: Promise.resolve({ section: "general" }) },
		);
		assert.equal(response.status, 200);
		if (here) notifySettingsSaved("general");
	});
}

/** Long enough for the list's trailing debounce and the fetches it starts. */
async function settle(ms = EVENT_REFRESH_MS + 150) {
	const until = Date.now() + ms;
	while (Date.now() < until) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

const MIN = 60_000;
const rowsText = () => [...document.querySelectorAll('[data-testid="session-row"]')].map((row) => row.textContent ?? "");
const figures = () => [...document.querySelectorAll('[data-testid="session-time"]')].map((el) => el.textContent);

const steps = (from: number, count: number, startAt: number): LhMessage[] =>
	Array.from({ length: count }, (_, i) => ({
		id: `u${from + i}`,
		role: "user" as const,
		content: "more",
		timestamp: startAt + (i + 1) * 10 * MIN,
	}));
const timed = chatStore.createChat("Timed lesson");
// 10 (the first gap, capped) + 8 × 10 = 90 minutes.
const lesson: LhMessage[] = [
	{ id: "u1", role: "user", content: "hi", timestamp: 0 },
	{ id: "u2", role: "user", content: "again", timestamp: 80 * MIN },
	...steps(3, 8, 80 * MIN),
];
chatStore.saveMessages(timed.id, lesson);
chatStore.createChat("Empty lesson");

it("off by default: no figure on any row", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<AppRouterContext.Provider value={router as never}>
				<PathnameContext.Provider value="/">
					<ServerEventsProvider connect={busChannel}>
						<SidebarProvider>
							<AppShell>
								<div />
							</AppShell>
						</SidebarProvider>
					</ServerEventsProvider>
				</PathnameContext.Provider>
			</AppRouterContext.Provider>,
		),
	);
	await settle();
	assert.equal(rowsText().length, 2, "both lessons are listed");
	assert.deepEqual(figures(), []);
	assert.ok(!rowsText().some((text) => text.includes("1h 30m")));
});

it("switching on in this window shows the figure without a reload; off takes it away", async () => {
	const before = listFetches.length;
	await setGeneral({ showLessonTime: true }, true);
	await settle();
	assert.ok(listFetches.length > before, "switching on refetches the list");
	assert.deepEqual(figures(), ["Time spent: 1h 30m"], "the empty lesson shows nothing");
	await setGeneral({ showLessonTime: false }, true);
	await settle();
	assert.deepEqual(figures(), []);
});

it("follows the switch flipped in another window (the server's settings-changed event)", async () => {
	const reads = settingsReads;
	await setGeneral({ showLessonTime: true }, false);
	await settle();
	assert.deepEqual(figures(), ["Time spent: 1h 30m"]);
	assert.equal(settingsReads, reads + 1, "every General reader hears the event; one read serves them all");
	await setGeneral({ showLessonTime: false }, false);
	await settle();
	assert.deepEqual(figures(), []);
});

it("catches a switch flipped while disconnected on the reconnect", async () => {
	writeSettings({ version: 1, general: { showLessonTime: true } }); // no event reaches this window
	await settle();
	assert.deepEqual(figures(), [], "nothing told this window yet");
	await act(async () => reopen!());
	await settle();
	assert.deepEqual(figures(), ["Time spent: 1h 30m"]);
});

it("a silent record write (a dismissal's record-changed) updates the figure", async () => {
	const before = listFetches.length;
	chatStore.saveMessages(timed.id, [...lesson, ...steps(11, 2, 160 * MIN)]);
	await act(async () => emit("record-changed", { chatId: timed.id }));
	await settle();
	assert.equal(listFetches.length, before + 1, "one debounced list fetch");
	assert.deepEqual(figures(), ["Time spent: 1h 50m"]);
});

it("with the switch off, record-changed costs no list fetch", async () => {
	await setGeneral({ showLessonTime: false }, false);
	await settle();
	assert.deepEqual(figures(), []);
	const before = listFetches.length;
	await act(async () => emit("record-changed", { chatId: timed.id }));
	await settle();
	assert.equal(listFetches.length, before);
});
