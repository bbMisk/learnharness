/**
 * The mounted app shell for the time-spent sidebar tests (owner, 2026-11-05):
 * a linkedom window, the real chat-list and settings routes in a temp data
 * dir, and an events channel fed by the server's own bus (what /api/events
 * streams). Import it before anything that loads React DOM; each test file
 * runs in its own process, so each gets fresh client stores.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { LhMessage } from "../../src/core/native-messages.ts";

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
const { AppShell, SidebarProvider } = await import("../../components/sidebar.tsx");
const { ServerEventsProvider } = await import("../../components/server-events.tsx");
const { EVENT_REFRESH_MS } = await import("../../components/chat-list-refresh.ts");
const { notifySettingsSaved } = await import("../../components/settings-signal.ts");
const { subscribe } = await import("../../src/core/events.ts");
const listing = await import("../../app/api/chats/route.ts");
const settingsRoute = await import("../../app/api/settings/route.ts");
const settingsSection = await import("../../app/api/settings/[section]/route.ts");
export const { emit } = await import("../../src/core/events.ts");
export const { writeSettings } = await import("../../src/store/settings.ts");
export const { chatStore } = await import("../../src/store/chats.ts");

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
/** Reopens the events channel (a reconnect). */
export const channel: { reopen?: () => void } = {};
const busChannel = () => {
	const handlers = new Map<string, (raw: string) => void>();
	const off = subscribe(({ type, ...payload }) => handlers.get(type)?.(JSON.stringify(payload)));
	return {
		close: () => void off(),
		onOpen: (cb: () => void) => void (channel.reopen = cb),
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

/** Requests the window made, by kind. */
export const served = { lists: 0, settingsReads: 0 };
/** The window's fetch, answered by the real routes. */
export async function serverFetch(input: RequestInfo | URL): Promise<Response> {
	const url = String(input);
	if (url === "/api/chats") {
		served.lists++;
		return listing.GET(new Request("http://test/api/chats"));
	}
	if (url === "/api/settings") {
		served.settingsReads++;
		return settingsRoute.GET();
	}
	return new Response("{}", { status: 404 });
}
globalThis.fetch = serverFetch as typeof fetch;

export async function mountSidebar(): Promise<void> {
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
}

/** Save the General section through the real route (it emits settings-changed).
 *  `here`: this window saved it, so its settings dialog also signals locally. */
export async function setGeneral(general: Record<string, unknown>, here: boolean): Promise<void> {
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
export async function settle(ms = EVENT_REFRESH_MS + 150): Promise<void> {
	const until = Date.now() + ms;
	while (Date.now() < until) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

export const MIN = 60_000;
export const rowsText = () => [...document.querySelectorAll('[data-testid="session-row"]')].map((row) => row.textContent ?? "");
export const figures = () => [...document.querySelectorAll('[data-testid="session-time"]')].map((el) => el.textContent);

/** `count` learner messages, ten minutes apart, after `startAt`. */
export const steps = (from: number, count: number, startAt: number): LhMessage[] =>
	Array.from({ length: count }, (_, i) => ({
		id: `u${from + i}`,
		role: "user" as const,
		content: "more",
		timestamp: startAt + (i + 1) * 10 * MIN,
	}));

/** A timed lesson (10, the first gap capped, + 8 × 10 = 90 minutes) and an empty one. */
export function seedLessons(): { id: string; lesson: LhMessage[] } {
	const timed = chatStore.createChat("Timed lesson");
	const lesson: LhMessage[] = [
		{ id: "u1", role: "user", content: "hi", timestamp: 0 },
		{ id: "u2", role: "user", content: "again", timestamp: 80 * MIN },
		...steps(3, 8, 80 * MIN),
	];
	chatStore.saveMessages(timed.id, lesson);
	chatStore.createChat("Empty lesson");
	return { id: timed.id, lesson };
}
