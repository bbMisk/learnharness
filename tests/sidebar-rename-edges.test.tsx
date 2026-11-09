/** Sidebar rename and menu edges: focus never drops to <body>, an unchanged
 *  name saves nothing, a stale error clears, and the search walk's menu
 *  keeps the search's way back. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { assertSameNode } from "./helpers/same-node.ts";
import { after, beforeEach, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const storage = new Map<string, string>([["lh:sidebar-open", "1"]]);
Object.assign(dom.window, { innerWidth: 1400, innerHeight: 900 });
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, self: globalThis,
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
Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView() {}, select() {} });
// linkedom has no focus model: track it, and a removed element lets go.
let focused: Element | null = null;
dom.window.HTMLElement.prototype.focus = function (this: Element) { focused = this; };
dom.window.HTMLElement.prototype.blur = function (this: Element) { if (focused === this) focused = null; };
Object.defineProperty(dom.document, "activeElement", { get: () => (focused?.isConnected ? focused : dom.document.body), configurable: true });

const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
const { createRoot } = await import("react-dom/client");
const { AppShell, SidebarProvider } = await import("../components/sidebar.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const quietChannel = () => ({ close() {}, onOpen() {}, onEvent() {} });
const chats = [
	{ id: "chat_a", title: "Alpha", kind: "teach", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", messageCount: 0 },
	{ id: "chat_b", title: "Beta", kind: "teach", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", messageCount: 0 },
];
const puts: string[] = [];
let putFails = true;
let putDelay = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (init?.method === "PUT") {
		puts.push(url);
		await new Promise((resolve) => setTimeout(resolve, putDelay));
		if (putFails) throw new TypeError("Failed to fetch");
		return Response.json({});
	}
	if (url === "/api/chats") return Response.json({ chats });
	if (url === "/api/projects") return Response.json({ projects: [] });
	return new Response("{}", { status: 404 });
}) as typeof fetch;

let root: Root | undefined;
const host = document.createElement("div");
document.body.append(host);
root = createRoot(host);
await act(async () =>
	root!.render(
		<AppRouterContext.Provider value={router as never}>
			<PathnameContext.Provider value="/chat/x">
				<ServerEventsProvider connect={quietChannel}>
					<SidebarProvider>
						<AppShell>
							<div data-testid="composer"><textarea data-file-path-input="" /></div>
						</AppShell>
					</SidebarProvider>
				</ServerEventsProvider>
			</PathnameContext.Provider>
		</AppRouterContext.Provider>,
	),
);
after(async () => {
	await act(async () => root?.unmount());
	globalThis.fetch = realFetch;
});
beforeEach(() => {
	puts.length = 0;
	putFails = true;
	putDelay = 0;
});

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}
await settle();
async function key(target: Element | Document, name: string, mods: { altKey?: boolean; shiftKey?: boolean } = {}) {
	const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: name, altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, ...mods });
	await act(async () => target.dispatchEvent(event));
}
const composer = () => document.querySelector('[data-testid="composer"] textarea')!;
const renameInput = () => document.querySelector<HTMLInputElement>('[data-testid="session-rename-input"]');
const row = (title: string) => [...document.querySelectorAll<HTMLElement>('[data-testid="session-row"]')].find((el) => el.textContent?.includes(title))!;
async function startRename(title: string) {
	focused = row(title); // a right-click focuses the row
	await act(async () => row(title).dispatchEvent(new dom.window.Event("contextmenu", { bubbles: true, cancelable: true })));
	await act(async () => (document.querySelector('[data-testid="ctx-rename"]') as HTMLElement).click());
	const input = renameInput()!;
	assert.ok(input, "the row is a field");
	return input;
}
async function type(input: HTMLInputElement, value: string) {
	input.setAttribute("type", "text");
	Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
	await act(async () => input.dispatchEvent(new dom.window.Event("input", { bubbles: true })));
}
/** Enter: the row's own keydown blurs it, which commits. */
async function enter(input: HTMLInputElement) {
	await key(input, "Enter");
	await act(async () => input.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
}

it("Esc or Enter in a chat rename hands focus to the typing field, not <body>", async () => {
	await key(await startRename("Alpha"), "Escape");
	await settle();
	assertSameNode(focused, composer(), "Esc: the composer");
	await enter(await startRename("Alpha"));
	await settle();
	assertSameNode(focused, composer(), "Enter: the composer");
});

it("an unchanged name just closes the row: no save, no error", async () => {
	await enter(await startRename("Alpha"));
	await settle();
	assert.deepEqual(puts, []);
	assertSameNode(renameInput(), null);
	assert.ok(![...document.querySelectorAll('[role="alert"]')].some((el) => /renamed/.test(el.textContent ?? "")));
});

it("a failed rename's error clears when another chat's rename starts", async () => {
	const input = await startRename("Alpha");
	await type(input, "Alpha two");
	focused = composer(); // a click away
	await act(async () => input.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
	await settle();
	assert.ok([...document.querySelectorAll('[role="alert"]')].some((el) => /renamed/.test(el.textContent ?? "")), "the failure shows");
	await startRename("Beta");
	assert.ok(![...document.querySelectorAll('[role="alert"]')].some((el) => /renamed/.test(el.textContent ?? "")), "and clears for the next rename");
	await key(renameInput()!, "Escape");
	await settle();
});

it("a late Enter failure reopens the row quietly once the user has moved on", async () => {
	putDelay = 200;
	const input = await startRename("Beta");
	await type(input, "Beta two");
	await enter(input);
	await settle(); // focus went back to the composer
	await key(composer(), "x"); // and the user typed on
	await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
	await settle();
	assert.ok(renameInput(), "the row reopened with the name");
	assertSameNode(focused, composer(), "the composer, still");
	await key(renameInput()!, "Escape");
	await settle();
});

it("the search walk's menu keeps the way back: Esc, Esc returns to the composer", async () => {
	composer();
	focused = composer();
	await act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-sessions-search")));
	await settle();
	const search = document.querySelector<HTMLInputElement>('[data-testid="session-search"]')!;
	assertSameNode(focused, search, "the search");
	await key(search, "ArrowDown");
	await key(search, "F10", { shiftKey: true });
	const item = document.querySelector<HTMLElement>('[data-testid="ctx-rename"]')!;
	// The menu takes focus from the search.
	focused = item;
	await act(async () => search.dispatchEvent(Object.assign(new dom.window.Event("focusout", { bubbles: true }), { relatedTarget: item })));
	await key(item, "Escape");
	await settle();
	assertSameNode(focused, search, "Esc 1: the search");
	await key(search, "Escape");
	await settle();
	assertSameNode(focused, composer(), "Esc 2: the composer");
});

it("closing the sidebar closes its chat menu", async () => {
	const first = document.querySelector<HTMLElement>('[data-testid="session-row"]')!;
	focused = first;
	await act(async () => first.dispatchEvent(new dom.window.Event("contextmenu", { bubbles: true, cancelable: true })));
	assert.ok(document.querySelector('[data-testid="ctx-rename"]'), "the menu is open");
	await act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-toggle-sidebar")));
	await settle();
	assertSameNode(document.querySelector('[data-testid="ctx-rename"]'), null, "the menu closed with the sidebar");
	await act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-toggle-sidebar")));
	await settle();
});
