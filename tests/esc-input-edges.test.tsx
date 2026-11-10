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
// As in Chrome, a field that turns disabled loses focus.
Object.defineProperty(dom.document, "activeElement", { get: () => (focused?.isConnected && !(focused as HTMLButtonElement).disabled ? focused : dom.document.body), configurable: true });

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

it("Find and the side tutor both open: an Esc from outside both closes the one opened last", async () => {
	const { SideTutor } = await import("../components/side-tutor.tsx");
	const { SessionFind } = await import("../components/session-find.tsx");
	globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
	const tutorOpen = () => !!document.querySelector('[data-testid="side-tutor"]');
	let setTutor!: (open: boolean) => void;
	function Page() {
		const [tutor, set] = useState(false);
		setTutor = set;
		return <>{tutor && <SideTutor chatId="c1" selectedText="" onClose={() => set(false)} />}<SessionFind scopeRef={{ current: scope as HTMLDivElement }} scrollContextRef={{ current: null }} /></>;
	}
	const scope = document.createElement("div");
	hosts.push(scope);
	mountHost();
	await act(async () => { root!.render(<Page />); });
	// The tutor, then Find: Find goes first.
	await act(async () => setTutor(true));
	await openFind();
	focused = null;
	await act(async () => { document.dispatchEvent(key("Escape")); });
	assert.ok(!findOpen() && tutorOpen(), "Find, the newest, closed");
	await act(async () => { document.dispatchEvent(key("Escape")); });
	assert.ok(!tutorOpen());
	// Find, then the tutor: the tutor goes first.
	await openFind();
	await act(async () => setTutor(true));
	focused = null;
	await act(async () => { document.dispatchEvent(key("Escape")); });
	assert.ok(findOpen() && !tutorOpen(), "the tutor, the newest, closed");
	await act(async () => { document.dispatchEvent(key("Escape")); });
	assert.ok(!findOpen());
});

it("the side tutor's Stop stops: the click it takes never submits the box again", async () => {
	const { SideTutor } = await import("../components/side-tutor.tsx");
	const snapshot = { context: "c", truncated: false, model: { provider: "openai", id: "m" } };
	const { createRange } = document;
	const getSelection = dom.window.getSelection;
	Object.assign(document, { createRange: () => ({ setStart() {}, setEnd() {}, selectNodeContents() {}, getClientRects: () => [], getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) }) });
	Object.assign(dom.window, { getSelection: () => ({ toString: () => "", rangeCount: 0, removeAllRanges() {}, addRange() {} }) });
	let posts = 0;
	// A reply that streams until it is aborted.
	globalThis.fetch = (async (_url: string, init?: RequestInit) => {
		if (init?.method !== "POST") return Response.json(snapshot);
		posts++;
		return new Response(new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "delta", text: "A limit point" })}\n`));
				init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
			},
		}));
	}) as unknown as typeof fetch;
	try {
		mountHost();
		await act(async () => { root!.render(<SideTutor chatId="c1" selectedText="what is a limit point" onClose={() => {}} />); });
		await frame();
		const box = document.querySelector<HTMLTextAreaElement>('[data-testid="side-tutor"] textarea')!;
		await act(async () => { box.dispatchEvent(key("Enter")); });
		await frame();
		const stop = document.querySelector<HTMLButtonElement>('[aria-label="Stop side response"]')!;
		assert.ok(stop, "Stop shows while the reply streams");
		// A real click re-renders Stop as Send before its default action runs; the browser
		// then submits the form if the button is a submit button and nothing prevented it.
		const click = new dom.window.Event("click", { bubbles: true, cancelable: true });
		await act(async () => { stop.dispatchEvent(click); await Promise.resolve(); });
		await frame();
		if (!click.defaultPrevented && stop.isConnected && stop.getAttribute("type") === "submit") {
			await act(async () => { stop.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
			await frame();
		}
		assert.equal(posts, 1, "the question is not sent again");
		assert.ok(document.querySelector('[data-testid="side-tutor"]')!.textContent!.includes("Side response stopped."));
	} finally {
		Object.assign(dom.window, { getSelection });
		Object.assign(document, { createRange });
	}
});

it("a double click on the side tutor's Stop or Send does one click's worth", async () => {
	const { SideTutor } = await import("../components/side-tutor.tsx");
	const snapshot = { context: "c", truncated: false, model: { provider: "openai", id: "m" } };
	const { createRange } = document;
	const getSelection = dom.window.getSelection;
	Object.assign(document, { createRange: () => ({ setStart() {}, setEnd() {}, selectNodeContents() {}, getClientRects: () => [], getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) }) });
	Object.assign(dom.window, { getSelection: () => ({ toString: () => "", rangeCount: 0, removeAllRanges() {}, addRange() {} }) });
	let posts = 0, aborts = 0;
	globalThis.fetch = (async (_url: string, init?: RequestInit) => {
		if (init?.method !== "POST") return Response.json(snapshot);
		posts++;
		return new Response(new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "delta", text: "A limit point" })}\n`));
				init.signal?.addEventListener("abort", () => { aborts++; controller.error(new DOMException("aborted", "AbortError")); });
			},
		}));
	}) as unknown as typeof fetch;
	// One click of a real double click on the Stop/Send slot (detail 1, then 2). A browser
	// submits the form after a submit button's click unless something prevented it.
	const clickSlot = async (detail: number) => {
		const button = document.querySelector<HTMLButtonElement>('[aria-label="Stop side response"], [aria-label="Send side question"]')!;
		const click = Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { button: 0, detail });
		await act(async () => { button.dispatchEvent(click); await Promise.resolve(); });
		if (!click.defaultPrevented && button.isConnected && button.getAttribute("type") === "submit" && !button.disabled) {
			await act(async () => { button.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
		}
		await frame();
	};
	try {
		mountHost();
		await act(async () => { root!.render(<SideTutor chatId="c1" selectedText="what is a limit point" onClose={() => {}} />); });
		await frame();
		await clickSlot(1);
		await clickSlot(2);
		assert.equal(posts, 1, "Send sends once");
		assert.equal(aborts, 0, "the second click does not stop what the first sent");
		await clickSlot(1);
		await clickSlot(2);
		assert.equal(aborts, 1, "Stop stops");
		assert.equal(posts, 1, "and the second click does not send the question again");
		assert.ok(document.querySelector('[data-testid="side-tutor"]')!.textContent!.includes("Side response stopped."));
		await clickSlot(1);
		assert.equal(posts, 2, "a later single click sends");
	} finally {
		Object.assign(dom.window, { getSelection });
		Object.assign(document, { createRange });
	}
});

it("a side tutor opened while the server or network was down loads its lesson context once it is back", async () => {
	const { SideTutor } = await import("../components/side-tutor.tsx");
	const { ServerEventsProvider } = await import("../components/server-events.tsx");
	const snapshot = { context: "c", truncated: false, model: { provider: "openai", id: "m" } };
	for (const back of ["online", "reconnect"] as const) {
		let up = false, reads = 0, reopen = () => {};
		globalThis.fetch = (async () => {
			reads++;
			if (!up) throw new TypeError("Failed to fetch");
			return Response.json(snapshot);
		}) as unknown as typeof fetch;
		const connect = () => ({ close() {}, onEvent() {}, onOpen(cb: () => void) { reopen = cb; } });
		mountHost();
		await act(async () => { root!.render(<ServerEventsProvider connect={connect}><SideTutor chatId="c1" selectedText="why" onClose={() => {}} /></ServerEventsProvider>); });
		await frame();
		const send = () => document.querySelector<HTMLButtonElement>('[aria-label="Send side question"]')!;
		assert.ok(send().disabled, "no context, no send");
		assert.ok(document.querySelector('[data-testid="side-tutor"]')!.textContent!.includes("Failed to fetch"));
		up = true;
		await act(async () => { if (back === "online") window.dispatchEvent(new dom.window.Event("online")); else reopen(); });
		await frame();
		assert.equal(reads, 2, `${back}: the read retried`);
		assert.ok(!send().disabled, `${back}: Send works again`);
		assert.ok(!document.querySelector('[data-testid="side-tutor"]')!.textContent!.includes("Failed to fetch"));
		assert.equal(document.querySelector<HTMLTextAreaElement>('[data-testid="side-tutor"] textarea')!.value, "Help me understand this:\n\nwhy", "the draft is kept");
		await act(async () => { root!.unmount(); });
		root = null;
	}
});

it("after a side-tutor reply, success or failure, its box has focus again for the follow-up", async () => {
	const { SideTutor } = await import("../components/side-tutor.tsx");
	const snapshot = { context: "c", truncated: false, model: { provider: "openai", id: "m" } };
	// The streamed reply's markdown measures text ranges and selections; linkedom has neither.
	const { createRange } = document;
	const getSelection = dom.window.getSelection;
	Object.assign(document, { createRange: () => ({ setStart() {}, setEnd() {}, selectNodeContents() {}, getClientRects: () => [], getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) }) });
	Object.assign(dom.window, { getSelection: () => ({ toString: () => "", rangeCount: 0, removeAllRanges() {}, addRange() {} }) });
	const replies = [
		() => new Response(`${JSON.stringify({ type: "delta", text: "A limit point is…" })}\n${JSON.stringify({ type: "done" })}\n`),
		() => Response.json({ error: "The lesson's model connection is unavailable." }, { status: 503 }),
	];
	try {
		for (const reply of replies) {
			globalThis.fetch = (async (_url: string, init?: RequestInit) => (init?.method === "POST" ? reply() : Response.json(snapshot))) as unknown as typeof fetch;
			mountHost();
			await act(async () => { root!.render(<SideTutor chatId="c1" selectedText="what is a limit point" onClose={() => {}} />); });
			await frame();
			const box = document.querySelector<HTMLTextAreaElement>('[data-testid="side-tutor"] textarea')!;
			assertSameNode(document.activeElement, box);
			await act(async () => { box.dispatchEvent(key("Enter")); });
			for (let i = 0; i < 100 && box.disabled; i++) await frame();
			assert.ok(!box.disabled, "the reply settled");
			assertSameNode(document.activeElement, box, "focus is back in the box");
			await act(async () => { root!.unmount(); });
			root = null;
		}
	} finally {
		Object.assign(dom.window, { getSelection });
		Object.assign(document, { createRange });
	}
});

it("Find and the side tutor both open: an Esc from a field the user clicked into closes the newest and leaves focus there", async () => {
	const { SideTutor, useSideTutor } = await import("../components/side-tutor.tsx");
	const { SessionFind } = await import("../components/session-find.tsx");
	const { kbdEventForAction } = await import("../src/core/keyboard.ts");
	globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
	const scope = document.createElement("div");
	hosts.push(scope);
	function Page() {
		const { sideTutor, closeSideTutor } = useSideTutor();
		return <>
			<textarea data-testid="thinking" />
			{sideTutor && <SideTutor chatId="c1" selectedText="" onClose={closeSideTutor} />}
			<SessionFind scopeRef={{ current: scope as HTMLDivElement }} scrollContextRef={{ current: null }} />
		</>;
	}
	mountHost();
	await act(async () => { root!.render(<Page />); });
	const thinking = document.querySelector<HTMLTextAreaElement>('[data-testid="thinking"]')!;
	const tutorOpen = () => !!document.querySelector('[data-testid="side-tutor"]');
	const openTutor = () => act(async () => { window.dispatchEvent(new dom.window.Event(kbdEventForAction("toggle-side-tutor"))); });
	// The tutor, then Find (which would hand focus back to the tutor's box).
	thinking.focus();
	await openTutor();
	await openFind();
	thinking.focus();
	await act(async () => { thinking.dispatchEvent(key("Escape")); });
	await frame();
	assert.ok(!findOpen() && tutorOpen());
	assertSameNode(document.activeElement, thinking, "Find closed; focus stays in Your thinking");
	await act(async () => { thinking.dispatchEvent(key("Escape")); });
	await frame();
	assert.ok(!tutorOpen());
	// Find, then the tutor (which would hand focus back to Find's input).
	await openFind();
	await openTutor();
	thinking.focus();
	await act(async () => { thinking.dispatchEvent(key("Escape")); });
	await frame();
	assert.ok(findOpen() && !tutorOpen());
	assertSameNode(document.activeElement, thinking, "the tutor closed; focus stays in Your thinking");
	// From nowhere (a click on the page), the closing layer still hands focus back.
	focused = null;
	await act(async () => { document.dispatchEvent(key("Escape")); });
	await frame();
	assert.ok(!findOpen());
	assertSameNode(document.activeElement, thinking, "back to where Find was opened from");
});

it("a double click on the composer's Send or Next problem does not also hit the Stop it turns into", async () => {
	const { Composer } = await import("../components/composer.tsx");
	const calls: string[] = [];
	function Host({ next }: { next: boolean }) {
		const [busy, setBusy] = useState(false);
		return (
			<Composer
				busy={busy}
				value={next ? "" : "why?"}
				onChange={() => {}}
				canSend={!busy && !next}
				nextProblem={next}
				onSend={() => { calls.push("send"); setBusy(true); }}
				onNext={() => { calls.push("next"); setBusy(true); }}
				onStop={() => calls.push("stop")}
			/>
		);
	}
	// One click of a real double click (detail 1, then 2): the browser submits the form
	// after a submit button's click unless something prevented it.
	const clickSlot = async (detail: number) => {
		const button = document.querySelector<HTMLButtonElement>('[data-testid="composer"] button[type="submit"]')!;
		const click = Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { button: 0, detail });
		await act(async () => { button.dispatchEvent(click); });
		if (!click.defaultPrevented && !button.disabled) {
			await act(async () => { button.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
		}
	};
	for (const next of [false, true]) {
		calls.length = 0;
		mountHost();
		await act(async () => { root!.render(<Host next={next} />); });
		await clickSlot(1);
		await clickSlot(2);
		assert.deepEqual(calls, [next ? "next" : "send"], "the second click is ignored");
		await clickSlot(1);
		assert.deepEqual(calls, [next ? "next" : "send", "stop"], "a later single click on Stop stops");
		await act(async () => { root?.unmount(); });
		root = null;
	}
});

it("phone drawer: a shortcut that opens something on the page closes it; its own search keeps it", async () => {
	phone = true;
	const { SidebarProvider, useSidebar } = await import("../components/sidebar.tsx");
	const { kbdEventForAction } = await import("../src/core/keyboard.ts");
	let sidebar!: ReturnType<typeof useSidebar>;
	function Probe() { sidebar = useSidebar(); return null; }
	mountHost();
	await act(async () => { root!.render(<SidebarProvider><Probe /></SidebarProvider>); });
	for (const action of ["find", "toggle-side-tutor", "open-model-picker"] as const) {
		await act(async () => sidebar.toggle());
		assert.equal(sidebar.open, true);
		await act(async () => { window.dispatchEvent(new CustomEvent(kbdEventForAction(action))); });
		assert.equal(sidebar.open, false, `${action} closes the drawer that would cover it`);
	}
	await act(async () => sidebar.toggle());
	await act(async () => { window.dispatchEvent(new CustomEvent(kbdEventForAction("sessions-search"))); });
	assert.equal(sidebar.open, true, "searching chats happens in the drawer");
});

it("the setup dialog opens with focus on itself, not on ✕, so a second Enter cannot close it", async () => {
	const { SetupDialog } = await import("../components/setup-dialog.tsx");
	const get = globalThis.fetch;
	globalThis.fetch = (async () => Response.json({ providers: [], models: [], slots: { strong: null, cheap: null, vision: null } })) as typeof fetch;
	try {
		mountHost();
		await act(async () => { root!.render(<SetupDialog open onClose={() => assert.fail("closed")} onDone={() => {}} />); });
		await frame();
		assertSameNode(document.activeElement, document.querySelector('[data-testid="setup-dialog"]'), "focus is in the dialog");
	} finally {
		globalThis.fetch = get;
	}
});
