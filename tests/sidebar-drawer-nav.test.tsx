/** The phone drawer closes on a tap on its navigation, even when the tap
 *  changes only the query or nothing (Teaching/Practice on /chat/new). */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { after, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const storage = new Map<string, string>([["lh:sidebar-open", "1"]]);
Object.assign(dom.window, { innerWidth: 390, innerHeight: 844 });
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MouseEvent: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true, self: globalThis,
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
	matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
});
Object.assign(dom.document, { oninput: null });
Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView() {}, select() {} });

const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
const { createRoot } = await import("react-dom/client");
const { AppShell, SidebarProvider } = await import("../components/sidebar.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");

const pushed: string[] = [];
const router = { push: (url: string) => void pushed.push(url), replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const quietChannel = () => ({ close() {}, onOpen() {}, onEvent() {} });
const chats = [{ id: "chat_a", title: "Alpha", kind: "teach", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", messageCount: 0 }];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
	const url = String(input);
	if (url === "/api/chats") return Response.json({ chats });
	if (url === "/api/projects") return Response.json({ projects: [] });
	return new Response("{}", { status: 404 });
}) as typeof fetch;
let root: Root | undefined;
after(async () => {
	await act(async () => root?.unmount());
	globalThis.fetch = realFetch;
});
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 10))); };
const isOpen = () => document.querySelector("aside")!.getAttribute("aria-hidden") !== "true";
const openDrawer = async () => {
	await act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-toggle-sidebar")));
	await settle();
	assert.equal(isOpen(), true);
};
const tap = async (selector: string) => act(async () => (document.querySelector(selector) as HTMLElement).click());

it("Teaching, Practice and a chat row close the drawer on /chat/new; other buttons don't", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<AppRouterContext.Provider value={router as never}>
				<PathnameContext.Provider value="/chat/new">
					<ServerEventsProvider connect={quietChannel}>
						<SidebarProvider><AppShell><div /></AppShell></SidebarProvider>
					</ServerEventsProvider>
				</PathnameContext.Provider>
			</AppRouterContext.Provider>,
		),
	);
	await settle();
	for (const door of ["[data-testid='new-session']", "[data-testid='new-session-practice']", "[data-testid='session-row']"]) {
		await openDrawer();
		await tap(door);
		assert.equal(isOpen(), false, `${door} closes the drawer`);
	}
	assert.deepEqual(pushed, ["/chat/new", "/chat/new?mode=practice", "/chat/chat_a"]);
	await openDrawer();
	await tap("[data-testid='archive-view']");
	assert.equal(isOpen(), true, "a view toggle keeps it open");
});
