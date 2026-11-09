/** QA low items in the sessions sidebar: the search walk opens the walked
 *  row's context menu from the keyboard, a failed rename says so, and the
 *  delete dialog's Delete button takes focus. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { after, it } from "node:test";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

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
Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView() {}, select() {} });

const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
const { createRoot } = await import("react-dom/client");
const { AppShell, SidebarProvider } = await import("../components/sidebar.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { DeleteSessionBody } = await import("../components/delete-session-dialog.tsx");

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const quietChannel = () => ({ close() {}, onOpen() {}, onEvent() {} });
const chats = [
	{ id: "chat_a", title: "Alpha", kind: "teach", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", messageCount: 0 },
	{ id: "chat_b", title: "Beta", kind: "teach", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", messageCount: 0 },
];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (init?.method === "PUT") throw new TypeError("Failed to fetch"); // offline
	if (url === "/api/chats") return Response.json({ chats });
	if (url === "/api/projects") return Response.json({ projects: [] });
	return new Response("{}", { status: 404 });
}) as typeof fetch;
let root: Root | undefined;
after(async () => {
	await act(async () => root?.unmount());
	globalThis.fetch = realFetch;
});

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}
async function key(target: Element, name: string, mods: { altKey?: boolean; shiftKey?: boolean } = {}) {
	// linkedom has no KeyboardEvent; React reads the type, `key` and the modifiers.
	const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: name, altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, ...mods });
	await act(async () => target.dispatchEvent(event));
}
const menu = () => document.querySelector('[data-testid="session-context-menu"]');

it("⌥↵ on the walked row opens its menu; a failed rename shows an error", async () => {
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
	const search = document.querySelector('[data-testid="session-search"]')!;
	await key(search, "Enter", { altKey: true });
	assert.equal(menu(), null, "nothing walked yet: no menu");
	await key(search, "ArrowDown");
	await key(search, "ArrowDown");
	await key(search, "F10", { shiftKey: true });
	assert.ok(menu(), "⇧F10 opens the walked row's menu");
	await act(async () => (document.querySelector('[data-testid="ctx-rename"]') as HTMLElement).click());
	const input = document.querySelector('[data-testid="session-rename-input"]') as HTMLInputElement;
	assert.equal(input.value, "Beta", "the menu belongs to the walked (second) row");
	Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "Offline rename");
	await act(async () => input.dispatchEvent(new dom.window.Event("input", { bubbles: true })));
	await act(async () => input.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
	await settle();
	const alerts = [...document.querySelectorAll('[role="alert"]')].map((el) => el.textContent);
	assert.ok(alerts.includes("Chat could not be renamed. Try again."), `alerts: ${JSON.stringify(alerts)}`);

	await key(search, "ArrowDown");
	await key(search, "Enter", { altKey: true });
	assert.ok(menu(), "⌥↵ opens it too");
});

it("closing the walked row's menu hands focus back to the search; ⌘⇧F restarts the walk", async () => {
	const focused: Element[] = [];
	const realFocus = dom.window.HTMLElement.prototype.focus;
	dom.window.HTMLElement.prototype.focus = function (this: Element) {
		focused.push(this);
	};
	try {
		const search = document.querySelector('[data-testid="session-search"]')!;
		assert.ok(menu(), "the previous test left the menu open");
		await key(document as unknown as Element, "Escape");
		await settle();
		assert.equal(menu(), null);
		assert.equal(focused.at(-1), search, "Esc returns focus to the search");
		await key(search, "ArrowDown");
		await key(search, "F10", { shiftKey: true });
		focused.length = 0;
		await act(async () => (document.querySelector('[data-testid="ctx-archive"]')!.nextElementSibling as HTMLElement).click());
		await settle();
		assert.equal(focused.at(-1), search, "Pin returns focus to the search");
		await key(search, "ArrowDown"); // the walk now sits on the first row; the next ↓ would leave it
		await key(search, "ArrowDown");
		await act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-sessions-search")));
		await settle();
		await key(search, "ArrowDown");
		const walked = document.querySelector('[data-testid="session-row-kbd"]');
		const first = document.querySelector('[data-testid="unassigned-chat-list"] button');
		assert.equal(walked, first, "a new ⌘⇧F walk starts at the first row");
	} finally {
		dom.window.HTMLElement.prototype.focus = realFocus;
	}
});

it("the delete dialog focuses Delete, so Enter confirms", () => {
	const html = renderToStaticMarkup(
		<DeleteSessionBody chat={{ id: "c1", title: "T" }} traces={false} busy={false} failure={null} onTraces={() => {}} onClose={() => {}} onRun={() => {}} />,
	);
	assert.match(html, /<button[^>]*data-testid="delete-confirm"[^>]*autofocus=""/);
});
