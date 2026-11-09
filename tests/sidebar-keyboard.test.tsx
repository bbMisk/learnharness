/** QA low items in the sessions sidebar: the search walk opens the walked
 *  row's context menu from the keyboard, a failed rename says so, and the
 *  delete dialog's Delete button takes focus. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { assertSameNode } from "./helpers/same-node.ts";
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
const puts: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (init?.method === "PUT") {
		puts.push(url);
		await new Promise((resolve) => setTimeout(resolve, 20)); // in flight: the row stays hidden
		throw new TypeError("Failed to fetch"); // offline
	}
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
	assertSameNode(menu(), null, "nothing walked yet: no menu");
	await key(search, "ArrowDown");
	await key(search, "ArrowDown");
	await key(search, "F10", { shiftKey: true });
	assert.ok(menu(), "⇧F10 opens the walked row's menu");
	await act(async () => (document.querySelector('[data-testid="ctx-rename"]') as HTMLElement).click());
	const input = document.querySelector('[data-testid="session-rename-input"]') as HTMLInputElement;
	assert.equal(input.value, "Beta", "the menu belongs to the walked (second) row");
	input.setAttribute("type", "text"); // linkedom reports no type, so React would skip onChange
	Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "Offline rename");
	await act(async () => input.dispatchEvent(new dom.window.Event("input", { bubbles: true })));
	await act(async () => input.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
	await settle();
	const alerts = [...document.querySelectorAll('[role="alert"]')].map((el) => el.textContent);
	assert.ok(alerts.includes("Chat could not be renamed. Try again."), `alerts: ${JSON.stringify(alerts)}`);
	const reopened = document.querySelector('[data-testid="session-rename-input"]') as HTMLInputElement;
	assert.equal(reopened?.value, "Offline rename", "the failed rename keeps what was typed");
	await key(reopened, "Escape");
	assertSameNode(document.querySelector('[data-testid="session-rename-input"]'), null, "Esc discards it");
	assert.ok(![...document.querySelectorAll('[role="alert"]')].some((el) => /renamed/.test(el.textContent ?? "")), "and its error");

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
		assertSameNode(menu(), null);
		assertSameNode(focused.at(-1), search, "Esc returns focus to the search");
		await key(search, "ArrowDown");
		await key(search, "F10", { shiftKey: true });
		focused.length = 0;
		await act(async () => (document.querySelector('[data-testid="ctx-archive"]')!.nextElementSibling as HTMLElement).click());
		await settle();
		assertSameNode(focused.at(-1), search, "Pin returns focus to the search");
		await key(search, "ArrowDown"); // the walk now sits on the first row; the next ↓ would leave it
		await key(search, "ArrowDown");
		await act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-sessions-search")));
		await settle();
		await key(search, "ArrowDown");
		const walked = document.querySelector('[data-testid="session-row-kbd"]');
		const first = document.querySelector('[data-testid="unassigned-chat-list"] button');
		assertSameNode(walked, first, "a new ⌘⇧F walk starts at the first row");
	} finally {
		dom.window.HTMLElement.prototype.focus = realFocus;
	}
});

it("⌘B closing the sidebar makes it inert, so its search box lets go of focus", async () => {
	const aside = document.querySelector("aside")!;
	assert.equal(aside.hasAttribute("inert"), false, "open: usable");
	await act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-toggle-sidebar")));
	assert.equal(aside.getAttribute("aria-hidden"), "true");
	assert.equal(aside.hasAttribute("inert"), true, "closed: nothing inside is focusable");
	await act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-toggle-sidebar")));
	assert.equal(aside.hasAttribute("inert"), false);
});

it("⌘⇧F from a closed sidebar focuses the search, even before React would render", async () => {
	const focused: Element[] = [];
	const realFocus = dom.window.HTMLElement.prototype.focus;
	const realRaf = globalThis.requestAnimationFrame;
	dom.window.HTMLElement.prototype.focus = function (this: Element) {
		if (!this.closest("[inert]")) focused.push(this); // inert refuses focus
	};
	try {
		await act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-toggle-sidebar")));
		assert.equal(document.querySelector("aside")!.hasAttribute("inert"), true, "closed");
		// The next frame lands before React commits the open (a default-priority render can).
		globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
			globalThis.requestAnimationFrame = realRaf;
			cb(0);
			return 0;
		}) as typeof requestAnimationFrame;
		await act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-sessions-search")));
		assert.ok(focused.at(-1) === document.querySelector('[data-testid="session-search"]'), "the search has focus");
	} finally {
		globalThis.requestAnimationFrame = realRaf;
		dom.window.HTMLElement.prototype.focus = realFocus;
	}
});

it("⌘⇧F selects a kept query, so typing replaces it", async () => {
	const selected: Element[] = [];
	const proto = dom.window.HTMLElement.prototype as unknown as { select(): void };
	const realSelect = proto.select;
	proto.select = function (this: Element) {
		selected.push(this);
	};
	try {
		await act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-sessions-search")));
		await settle();
		assert.ok(selected.length === 1 && selected[0] === document.querySelector('[data-testid="session-search"]'), "the search's text is selected");
	} finally {
		proto.select = realSelect;
	}
});

it("focusing the search (⌘⇧F) leaves its tooltip closed, so it never covers the filters", async () => {
	const search = document.querySelector('[data-testid="session-search"]')!;
	await act(async () => void search.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })));
	assert.equal(search.parentElement!.getAttribute("data-state"), "closed");
	await act(async () => void search.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
});

it("an empty filtered list names the filter instead of saying there are no chats", async () => {
	const practice = document.querySelector('[data-testid="kind-filter-practice"]') as HTMLElement | null;
	assert.ok(practice, "the Practice filter is shown");
	await act(async () => practice.click());
	const list = () => document.querySelector('[data-testid="unassigned-chat-list"]')!.textContent;
	assert.equal(list(), "No practice chats yet.");
	await act(async () => (document.querySelector('[data-testid="archive-view"]') as HTMLElement).click());
	assert.equal(list(), "No archived practice chats.");
	await act(async () => (document.querySelector('[data-testid="archive-view"]') as HTMLElement).click());
	await act(async () => (document.querySelector('[data-testid="kind-filter-all"]') as HTMLElement).click());
});

it("Move to project marks where the chat is now", async () => {
	const search = document.querySelector('[data-testid="session-search"]')!;
	await act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-sessions-search")));
	await settle();
	await key(search, "ArrowDown");
	await key(search, "F10", { shiftKey: true });
	const noProject = [...menu()!.querySelectorAll("button")].find((b) => b.textContent === "No project")!;
	assert.equal(noProject.getAttribute("aria-current"), "true");
	await key(document as unknown as Element, "Escape");
});

it("a menu opened from the keyboard focuses its first item, so Enter acts", async () => {
	const focused: Element[] = [];
	const realFocus = dom.window.HTMLElement.prototype.focus;
	dom.window.HTMLElement.prototype.focus = function (this: Element) {
		focused.push(this);
	};
	try {
		const search = document.querySelector('[data-testid="session-search"]')!;
		await act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-sessions-search")));
		await settle();
		await key(search, "ArrowDown");
		await key(search, "F10", { shiftKey: true });
		await settle();
		assert.ok(menu(), "the menu is open");
		assert.ok(focused.at(-1) === document.querySelector('[data-testid="ctx-rename"]'), `focused: ${focused.at(-1)?.getAttribute("data-testid")}`);
		await key(document as unknown as Element, "Escape");
	} finally {
		dom.window.HTMLElement.prototype.focus = realFocus;
	}
});

it("lh:chat-archived (the open chat's Restore) patches the row at once", async () => {
	const titles = () => [...document.querySelectorAll('[data-testid="unassigned-chat-list"] button')].map((b) => b.textContent);
	assert.ok(titles().some((t) => t?.includes("Alpha")));
	await act(async () => void window.dispatchEvent(new CustomEvent("lh:chat-archived", { detail: { id: "chat_a", archived: true } })));
	assert.ok(!titles().some((t) => t?.includes("Alpha")), "archived: out of the active list");
	await act(async () => void window.dispatchEvent(new CustomEvent("lh:chat-archived", { detail: { id: "chat_a", archived: false } })));
	assert.ok(titles().some((t) => t?.includes("Alpha")), "restored: back");
});

it("the delete dialog focuses Delete, so Enter confirms", () => {
	const html = renderToStaticMarkup(
		<DeleteSessionBody chat={{ id: "c1", title: "T" }} traces={false} busy={false} failure={null} onTraces={() => {}} onClose={() => {}} onRun={() => {}} />,
	);
	assert.match(html, /<button[^>]*data-testid="delete-confirm"[^>]*autofocus=""/);
});

it("a long chat title wraps inside the delete dialog", () => {
	const html = renderToStaticMarkup(
		<DeleteSessionBody chat={{ id: "c1", title: "x".repeat(73) }} traces={false} busy={false} failure={null} onTraces={() => {}} onClose={() => {}} onRun={() => {}} />,
	);
	assert.match(html, /data-testid="session-name-code" class="[^"]*\bwrap-anywhere\b/);
});

const archiveIcon = () => document.querySelector('[data-testid="unassigned-chat-list"] [aria-label="Archive chat"]') as HTMLElement;
/** A mouse click; `detail` is the browser's click count (2 = a double click's second click). */
async function clickIcon(detail: number) {
	const event = Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail, button: 0 });
	await act(async () => archiveIcon().dispatchEvent(event));
}

it("a double click on a row's archive icon archives only that row, however slow", async () => {
	puts.length = 0;
	const realNow = Date.now;
	try {
		await clickIcon(1);
		// The row hid at once; the next row's icon now sits under the pointer.
		// A slow double click (the OS setting) is still click count 2.
		const later = realNow() + 800;
		Date.now = () => later;
		await clickIcon(2);
	} finally {
		Date.now = realNow;
	}
	await settle();
	await settle();
	assert.deepEqual(puts, ["/api/chats/chat_a"]);
});

it("two quick single clicks on two rows' archive icons archive both", async () => {
	await settle(); // the failed PUT above put Alpha back
	puts.length = 0;
	await clickIcon(1);
	await clickIcon(1);
	await settle();
	await settle();
	assert.deepEqual(puts, ["/api/chats/chat_a", "/api/chats/chat_b"]);
});

it("Esc in the search clears the query first, then leaves the search", async () => {
	const search = document.querySelector('[data-testid="session-search"]') as HTMLInputElement;
	const type = async (text: string) => {
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, text);
		await act(async () => search.dispatchEvent(new dom.window.Event("input", { bubbles: true })));
	};
	const blurred: Element[] = [];
	const realBlur = dom.window.HTMLElement.prototype.blur;
	dom.window.HTMLElement.prototype.blur = function (this: Element) {
		blurred.push(this);
	};
	try {
		search.setAttribute("type", "text");
		await type("Al");
		assert.equal(search.value, "Al");
		await key(search, "Escape");
		assert.equal(search.value, "", "the first Esc clears the query");
		assert.equal(blurred.length, 0, "and keeps focus");
		await key(search, "Escape");
		assert.deepEqual(blurred, [search], "the second Esc leaves the search");
	} finally {
		dom.window.HTMLElement.prototype.blur = realBlur;
	}
});

it("Esc out of a ⌘⇧F search hands focus back to the field it came from", async () => {
	const field = document.createElement("input");
	document.body.append(field);
	let active: Element = field;
	const proto = dom.window.HTMLElement.prototype;
	const { focus: realFocus, blur: realBlur } = proto;
	Object.defineProperty(document, "activeElement", { get: () => active, configurable: true });
	proto.focus = function (this: Element) { active = this; };
	proto.blur = function (this: Element) { if (active === this) active = document.body; };
	try {
		await act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-sessions-search")));
		await settle();
		const search = document.querySelector('[data-testid="session-search"]')!;
		assert.ok(active === search, "⌘⇧F focused the search");
		await key(search, "Escape");
		assert.ok(active === field, "Esc went back to the field, not the body");
	} finally {
		proto.focus = realFocus;
		proto.blur = realBlur;
		delete (document as { activeElement?: unknown }).activeElement;
		field.remove();
	}
});
