/**
 * Time spent in the real sidebar (owner, 2026-11-05): the mounted app shell
 * against the real chat-list and settings routes (temp data dir). Off by
 * default the rows show no figure; switching it on in Settings → General
 * brings the figure in without a reload; switching it off takes it away.
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
const { notifySettingsSaved } = await import("../components/settings-signal.ts");
const { chatStore } = await import("../src/store/chats.ts");
const listing = await import("../app/api/chats/route.ts");
const settingsRoute = await import("../app/api/settings/route.ts");
const settingsSection = await import("../app/api/settings/[section]/route.ts");

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const quietChannel = () => ({ close() {}, onOpen() {}, onEvent() {} });
const realFetch = globalThis.fetch;
let root: Root | undefined;
after(async () => {
	await act(async () => root?.unmount());
	globalThis.fetch = realFetch;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const listFetches: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
	const url = String(input);
	if (url === "/api/chats") {
		listFetches.push(url);
		return listing.GET(new Request("http://test/api/chats"));
	}
	if (url === "/api/settings") return settingsRoute.GET();
	return new Response("{}", { status: 404 });
}) as typeof fetch;

async function setGeneral(general: Record<string, unknown>) {
	const response = await settingsSection.PUT(
		new Request("http://test/api/settings/general", { method: "PUT", body: JSON.stringify(general) }),
		{ params: Promise.resolve({ section: "general" }) },
	);
	assert.equal(response.status, 200);
	// What the settings dialog does after a save (settings-signal).
	await act(async () => notifySettingsSaved("general"));
}

async function settle() {
	for (let i = 0; i < 20; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
}

const MIN = 60_000;
const rowsText = () => [...document.querySelectorAll('[data-testid="session-row"]')].map((row) => row.textContent ?? "");

it("the sidebar shows each lesson's time spent only while the General switch is on", async () => {
	const timed = chatStore.createChat("Timed lesson");
	chatStore.saveMessages(timed.id, [
		{ id: "u1", role: "user", content: "hi", timestamp: 0 },
		{ id: "u2", role: "user", content: "again", timestamp: 80 * MIN },
		...Array.from({ length: 8 }, (_, i) => ({
			id: `u${i + 3}`,
			role: "user" as const,
			content: "more",
			timestamp: 80 * MIN + (i + 1) * 10 * MIN,
		})),
	]);
	chatStore.createChat("Empty lesson");

	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<AppRouterContext.Provider value={router as never}>
				<PathnameContext.Provider value="/">
					<ServerEventsProvider connect={quietChannel}>
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
	assert.equal(document.querySelectorAll('[data-testid="session-time"]').length, 0, "off by default: no figure");
	assert.ok(!rowsText().some((text) => text.includes("1h 30m")));
	const fetchesBefore = listFetches.length;

	await setGeneral({ showLessonTime: true });
	await settle();
	assert.ok(listFetches.length > fetchesBefore, "switching on refetches the list");
	const figures = [...document.querySelectorAll('[data-testid="session-time"]')].map((el) => el.textContent);
	// 10 (first gap, capped) + 8 × 10 = 90 minutes; the empty lesson shows nothing.
	assert.deepEqual(figures, ["Time spent: 1h 30m"]);

	await setGeneral({ showLessonTime: false });
	await settle();
	assert.equal(document.querySelectorAll('[data-testid="session-time"]').length, 0, "off again: gone");
});
