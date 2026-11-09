import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { assertSameNode } from "./helpers/same-node.ts";
import { afterEach, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";

// Keys and input edges: an input method's Esc is the input method's; the
// phone drawer hears Esc first; renames hand focus somewhere useful.

const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
let phone = false;
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Node: dom.window.Node,
	CustomEvent: dom.window.CustomEvent, Event: dom.window.Event, MutationObserver: dom.window.MutationObserver,
	CSS: { highlights: new Map() }, IS_REACT_ACT_ENVIRONMENT: true, self: globalThis,
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, {
	innerWidth: 1280, innerHeight: 800,
	localStorage: (globalThis as { localStorage: unknown }).localStorage,
	matchMedia: () => ({ get matches() { return phone; }, addEventListener() {}, removeEventListener() {} }),
	getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", whiteSpace: "normal", getPropertyValue: () => "" }),
	getSelection: () => ({ toString: () => "" }),
});
Object.assign(dom.document, { oninput: null });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
Object.assign(dom.window.HTMLElement.prototype, { select() {} });
let focused: Element | null = null;
dom.window.HTMLElement.prototype.focus = function (this: HTMLElement) {
	if (!(this as HTMLButtonElement).disabled) focused = this;
};
dom.window.HTMLElement.prototype.blur = function (this: HTMLElement) {
	if (focused === this) focused = null;
};
Object.defineProperty(dom.document, "activeElement", { get: () => (focused?.isConnected ? focused : dom.document.body), configurable: true });

// linkedom has no capture phase: run the document's capture keydown listeners
// first, and let their stopPropagation skip its bubble-phase ones, as a browser does.
const captureKeydown = new Set<EventListener>();
document.addEventListener("keydown", (event) => {
	for (const listener of [...captureKeydown]) {
		listener(event);
		if (event.cancelBubble) { event.stopImmediatePropagation(); return; }
	}
});
const isCapture = (options?: boolean | AddEventListenerOptions) => options === true || (typeof options === "object" && !!options.capture);
const addListener = document.addEventListener.bind(document);
const removeListener = document.removeEventListener.bind(document);
Object.assign(document, {
	addEventListener: (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) =>
		type === "keydown" && isCapture(options) ? void captureKeydown.add(listener) : addListener(type, listener, options),
	removeEventListener: (type: string, listener: EventListener, options?: boolean | EventListenerOptions) =>
		type === "keydown" && isCapture(options) ? void captureKeydown.delete(listener) : removeListener(type, listener, options),
});

// react-dom reads the DOM's event support when it loads, so it loads after the setup above.
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

let root: Root | null = null;
const hosts: HTMLElement[] = [];
const originalFetch = globalThis.fetch;
afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = null;
	for (const host of hosts.splice(0)) host.remove();
	focused = null;
	phone = false;
	globalThis.fetch = originalFetch;
});
function mountHost(): HTMLElement {
	const host = document.createElement("div");
	document.body.append(host);
	hosts.push(host);
	root = createRoot(host);
	return host;
}
const key = (k: string, extra: Record<string, unknown> = {}) =>
	Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });
const imeEsc = () => key("Escape", { isComposing: true, keyCode: 229 });
const frame = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
const findOpen = () => !!document.querySelector('[data-testid="session-find"]');
async function openFind() {
	const { kbdEventForAction } = await import("../src/core/keyboard.ts");
	await act(async () => { window.dispatchEvent(new dom.window.Event(kbdEventForAction("find"))); });
	assert.ok(findOpen(), "Find opened");
}
async function type(input: HTMLInputElement, value: string) {
	input.setAttribute("type", "text");
	Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
	await act(async () => input.dispatchEvent(new dom.window.Event("input", { bubbles: true })));
}

it("an input method's Esc never reaches the global chain (no Dismiss confirm under the ⌘K picker)", async () => {
	const { KeyboardShortcuts } = await import("../components/keyboard-shortcuts.tsx");
	mountHost();
	await act(async () => {
		root!.render(<AppRouterContext.Provider value={router as never}><PathnameContext.Provider value="/chat/x"><KeyboardShortcuts /></PathnameContext.Provider></AppRouterContext.Provider>);
	});
	let aborts = 0;
	const onAbort = () => { aborts++; };
	window.addEventListener("lh:kbd-abort-turn", onAbort);
	try {
		window.dispatchEvent(imeEsc());
		assert.equal(aborts, 0, "the composition's Esc");
		window.dispatchEvent(key("Escape"));
		assert.equal(aborts, 1, "a plain Esc still reaches the chain");
	} finally {
		window.removeEventListener("lh:kbd-abort-turn", onAbort);
	}
});

it("an input method's Esc leaves Find open", async () => {
	const { SessionFind } = await import("../components/session-find.tsx");
	mountHost();
	const scope = document.createElement("div");
	hosts.push(scope);
	await act(async () => { root!.render(<SessionFind scopeRef={{ current: scope as HTMLDivElement }} scrollContextRef={{ current: null }} />); });
	await openFind();
	const input = document.querySelector('[data-testid="session-find"] input')!;
	await act(async () => { input.dispatchEvent(imeEsc()); });
	assert.ok(findOpen(), "the composition's Esc");
	await act(async () => { input.dispatchEvent(key("Escape")); });
	assert.ok(!findOpen());
});

it("the side tutor ignores an input method's Esc", async () => {
	const { SideTutor } = await import("../components/side-tutor.tsx");
	globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch; // the snapshot never matters here
	let closed = 0;
	mountHost();
	await act(async () => { root!.render(<SideTutor chatId="c1" selectedText="" onClose={() => { closed++; }} />); });
	const box = document.querySelector('[data-testid="side-tutor"] textarea')!;
	await act(async () => { box.dispatchEvent(imeEsc()); });
	assert.equal(closed, 0, "the composition's Esc");
	await act(async () => { box.dispatchEvent(key("Escape")); });
	assert.equal(closed, 1);
});

it("phone drawer: Esc from a field behind it closes the drawer first, before Find; its own fields keep their Esc", async () => {
	phone = true;
	const { SidebarProvider, useSidebar } = await import("../components/sidebar.tsx");
	const { SessionFind } = await import("../components/session-find.tsx");
	let sidebar!: ReturnType<typeof useSidebar>;
	function Probe() { sidebar = useSidebar(); return null; }
	const scope = document.createElement("div");
	hosts.push(scope);
	const host = mountHost();
	await act(async () => {
		root!.render(<SidebarProvider><Probe /><SessionFind scopeRef={{ current: scope as HTMLDivElement }} scrollContextRef={{ current: null }} />
			<aside data-lh-sidebar=""><input data-testid="drawer-field" /></aside><textarea data-testid="composer" /></SidebarProvider>);
	});
	const composer = host.querySelector('[data-testid="composer"]')!;
	await act(async () => sidebar.toggle());
	await act(async () => { host.querySelector('[data-testid="drawer-field"]')!.dispatchEvent(key("Escape")); });
	assert.equal(sidebar.open, true, "a field in the drawer owns its Esc");
	await act(async () => { composer.dispatchEvent(imeEsc()); });
	assert.equal(sidebar.open, true, "the composition's Esc");
	await act(async () => sidebar.toggle());
	await openFind(); // Find's listener registers before the drawer's
	await act(async () => sidebar.toggle());
	assert.equal(sidebar.open, true);
	await act(async () => { composer.dispatchEvent(key("Escape")); });
	assert.equal(sidebar.open, false, "the drawer is the top layer");
	assert.ok(findOpen(), "Find, under it, waits for the next Esc");
	await act(async () => { composer.dispatchEvent(key("Escape")); });
	assert.ok(!findOpen());
});

const { useSessionRename } = await import("../components/session-rename.ts");
function RenameHarness() {
	const r = useSessionRename("c1", "Old");
	return <>
		<button data-testid="title" onClick={() => { r.setTitleDraft("New"); r.setRenaming(true); }} />
		{r.renaming && <input ref={r.titleInputRef} data-testid="title-input" value={r.titleDraft}
			onChange={(e) => r.setTitleDraft(e.target.value)}
			onKeyDown={(e) => { if (e.key === "Enter") void r.commitRename(r.titleDraft); }}
			onBlur={() => void r.commitRename(r.titleDraft)} />}
		<p data-testid="err">{r.renameError}</p>
		<textarea data-testid="composer" />
	</>;
}
async function quietFailure(host: HTMLElement) {
	globalThis.fetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
	const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
	await act(async () => { q("title").click(); });
	q("composer").focus();
	await act(async () => { q("title-input").dispatchEvent(new dom.window.Event("focusout", { bubbles: true })); });
	await frame();
	assert.equal(q("err").textContent, "Chat could not be renamed. Try again.");
	assertSameNode(focused, q("composer"), "the composer");
	return q;
}

it("F2 moves into a quietly reopened header rename", async () => {
	const host = mountHost();
	await act(async () => { root!.render(<RenameHarness />); });
	const q = await quietFailure(host);
	await act(async () => { window.dispatchEvent(new dom.window.Event("lh:kbd-rename-session")); });
	assertSameNode(focused, q("title-input"), "the title field");
	assert.equal((q("title-input") as HTMLInputElement).value, "New", "the draft is kept");
});

it("a sidebar rename of the same chat closes the stale quiet header field", async () => {
	const host = mountHost();
	await act(async () => { root!.render(<RenameHarness />); });
	const q = await quietFailure(host);
	await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:chat-renamed", { detail: { id: "c1", title: "Via sidebar" } })); });
	assert.ok(q("title-input") === null, "the field closed");
	assert.equal(q("err").textContent, "");
	assertSameNode(focused, q("composer"), "the composer");
});

it("a late Enter failure doesn't take focus back once the user has moved on", async () => {
	let fail!: () => void;
	globalThis.fetch = (() => new Promise((resolve) => { fail = () => resolve({ ok: false, status: 500 }); })) as unknown as typeof fetch;
	const host = mountHost();
	await act(async () => { root!.render(<RenameHarness />); });
	const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
	await act(async () => { q("title").click(); });
	await act(async () => { q("title-input").dispatchEvent(key("Enter")); });
	q("composer").focus();
	q("composer").dispatchEvent(key("a")); // typing on in the composer
	await act(async () => { fail(); });
	await frame();
	assert.ok(q("title-input"), "the field reopened");
	assertSameNode(focused, q("composer"), "focus stays where the user is typing");
});

function InlineHost({ onCommit }: { onCommit: (name: string) => Promise<void> }) {
	const { InlineRename } = inline;
	const [renaming, setRenaming] = useState(true);
	return <div>
		<span />
		{renaming ? <InlineRename value="Alpha" ariaLabel="Name" onCommit={onCommit} onDone={() => setRenaming(false)} />
			: <button type="button" data-testid="name" onClick={() => setRenaming(true)}>Alpha</button>}
		<textarea data-testid="composer" />
	</div>;
}
const inline = await import("../components/inline-rename.tsx");

it("Enter or Esc on a project rename hands focus to its name, not <body>", async () => {
	for (const k of ["Escape", "Enter"]) {
		const host = mountHost();
		await act(async () => { root!.render(<InlineHost onCommit={async () => {}} />); });
		const input = host.querySelector("input")!;
		await type(input, "Beta");
		await act(async () => { input.dispatchEvent(key(k)); });
		await frame();
		assertSameNode(focused, host.querySelector('[data-testid="name"]'), k);
		await act(async () => { root!.unmount(); });
	}
});

it("a project rename's late Enter failure doesn't take focus back once the user has moved on", async () => {
	let fail!: () => void;
	const host = mountHost();
	await act(async () => { root!.render(<InlineHost onCommit={() => new Promise((_, reject) => { fail = () => reject(new Error("offline")); })} />); });
	const input = host.querySelector("input")!;
	await type(input, "Beta");
	await act(async () => { input.dispatchEvent(key("Enter")); });
	const composer = host.querySelector<HTMLElement>('[data-testid="composer"]')!;
	composer.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
	composer.focus();
	await act(async () => { fail(); });
	await frame();
	assertSameNode(focused, composer, "the composer");
	assert.ok(host.querySelector("input"), "the field stays open with the name");
});

it("Esc on a Chains name hands focus to the name; an input method's Esc keeps the rename", async () => {
	const { EditableSourceName } = await import("../components/source-folder-tree.tsx");
	const host = mountHost();
	await act(async () => { root!.render(<EditableSourceName name="LEC 4" onSave={async () => {}} />); });
	await act(async () => { host.querySelector("button")!.click(); });
	const input = host.querySelector("input")!;
	await act(async () => { input.dispatchEvent(imeEsc()); });
	assert.ok(host.querySelector("input"), "the composition's Esc");
	await act(async () => { input.dispatchEvent(key("Escape")); });
	assertSameNode(focused, host.querySelector("button"), "the name");
});

it("the demo bridge forwards an Esc the demo didn't use", async () => {
	const { buildDemoDocument } = await import("../src/core/demo-document.ts");
	for (const doc of [buildDemoDocument("<p>x</p>"), buildDemoDocument("<p>x</p>", "learnharness-v1", { d3: "", floatingUi: "" })]) {
		assert.match(doc, /e\.key==="Escape"&&!e\.defaultPrevented&&!e\.isComposing\)send\(\{type:"demo-escape"\}\)/);
	}
});
