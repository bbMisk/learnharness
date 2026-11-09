import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

// One focus return everywhere: closing Find, the side tutor, the ⌘K model
// menu or setup hands focus back with its caret, and the fallback finds the
// field the page types into (Your thinking while a check question waits).
const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Node: dom.window.Node,
	CustomEvent: dom.window.CustomEvent, Event: dom.window.Event, MutationObserver: dom.window.MutationObserver,
	CSS: { highlights: new Map() }, IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: { getItem: () => null, setItem() {} },
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, {
	innerWidth: 1280, innerHeight: 800,
	getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", whiteSpace: "normal", getPropertyValue: () => "" }),
	getSelection: () => ({ toString: () => "" }),
});
Object.assign(dom.document, { oninput: null });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
Object.assign(dom.window.HTMLElement.prototype, { select() {} });

// A minimal Selection (linkedom has none). Like Chrome, focusing a
// contenteditable whose selection is elsewhere puts the caret at its start.
type Range = { startContainer: Node; endContainer: Node; startOffset: number; endOffset: number; cloneRange(): Range };
const at = (node: Node, offset: number): Range => ({ startContainer: node, endContainer: node, startOffset: offset, endOffset: offset, cloneRange() { return at(node, offset); } });
let range: Range | null = null;
const selection = {
	get rangeCount() { return range ? 1 : 0; },
	getRangeAt: () => range!,
	removeAllRanges() { range = null; },
	addRange(r: Range) { range = r; },
	selectAllChildren(node: Node) { range = at(node, 0); Object.assign(range, { endOffset: node.childNodes.length }); },
	collapseToEnd() { if (range) range = at(range.endContainer, range.endOffset); },
};
Object.assign(document, { getSelection: () => selection });
let focused: Element | null = null;
dom.window.HTMLElement.prototype.focus = function (this: HTMLElement) {
	focused = this;
	if (!this.isContentEditable) range = null; // a plain field takes the selection
	else if (!(range && this.contains(range.startContainer))) range = at(this, 0);
};
Object.defineProperty(dom.document, "activeElement", { get: () => (focused?.isConnected ? focused : dom.document.body), configurable: true });

let root: Root | null = null;
const hosts: HTMLElement[] = [];
const originalFetch = globalThis.fetch;
afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = null;
	for (const host of hosts.splice(0)) host.remove();
	focused = null;
	range = null;
	globalThis.fetch = originalFetch;
});

/** A lesson text field (`testid` wraps it) holding "hello world". */
function field(testid: string): HTMLElement {
	const wrap = document.createElement("div");
	wrap.setAttribute("data-testid", testid);
	const el = document.createElement("div");
	el.setAttribute("data-file-path-input", "");
	el.textContent = "hello world";
	Object.defineProperty(el, "isContentEditable", { value: true });
	wrap.append(el);
	document.body.append(wrap);
	hosts.push(wrap);
	return el;
}
/** The learner was typing in `el` with the caret after "hello wo". */
function typingMidText(el: HTMLElement) {
	range = at(el.firstChild!, 8);
	el.focus();
}
const caretMidText = (el: HTMLElement) => focused === el && range?.startContainer === el.firstChild && range.startOffset === 8;
const caretAtEnd = (el: HTMLElement) => focused === el && range?.endContainer === el && range.startOffset === el.childNodes.length;
function mountHost(): HTMLElement {
	const host = document.createElement("div");
	document.body.append(host);
	hosts.push(host);
	root = createRoot(host);
	return host;
}
async function escape(target: EventTarget = document) {
	await act(async () => { target.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" })); });
}
const frame = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });

it("the fallback finds Your thinking while a check question waits, and skips a collapsed one", async () => {
	const { focusComposer } = await import("../components/focus-return.ts");
	const thinking = field("thinking-field");
	focusComposer();
	assert.ok(caretAtEnd(thinking), "Your thinking, caret after the draft");
	focused = null;
	Object.assign(thinking, { checkVisibility: () => false }); // collapsed: mounted but hidden
	const reading = field("reading-thinking-field");
	focusComposer();
	assert.ok(caretAtEnd(reading), "the visible field wins");
});

it("closing Find puts the caret back where it was", async () => {
	const { SessionFind } = await import("../components/session-find.tsx");
	const { kbdEventForAction } = await import("../src/core/keyboard.ts");
	const composer = field("composer");
	const scope = document.createElement("div");
	hosts.push(scope);
	mountHost();
	await act(async () => { root!.render(<SessionFind scopeRef={{ current: scope as HTMLDivElement }} scrollContextRef={{ current: null }} />); });
	typingMidText(composer);
	await act(async () => { window.dispatchEvent(new dom.window.Event(kbdEventForAction("find"))); });
	assert.ok(focused?.tagName === "INPUT", "Find took focus");
	await escape();
	assert.ok(caretMidText(composer), "the caret is where it was, not at the start");
});

it("closing the side tutor puts the caret back where it was", async () => {
	const { useSideTutor } = await import("../components/side-tutor.tsx");
	const { kbdEventForAction } = await import("../src/core/keyboard.ts");
	function Harness() {
		const { sideTutor } = useSideTutor();
		return sideTutor ? <textarea data-testid="tutor-input" /> : null;
	}
	const thinking = field("thinking-field");
	const host = mountHost();
	await act(async () => { root!.render(<Harness />); });
	typingMidText(thinking);
	await act(async () => { window.dispatchEvent(new dom.window.Event(kbdEventForAction("toggle-side-tutor"))); });
	host.querySelector<HTMLElement>('[data-testid="tutor-input"]')!.focus();
	await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:close-side-tutor")); });
	await frame();
	assert.ok(caretMidText(thinking));
});

it("Esc in the ⌘K model menu hands focus back mid-typing, caret kept", async () => {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		if (input === "/api/models") return Response.json({ models: [], providers: [], slots: {}, defaults: {} });
		return Response.json({ settings: null });
	}) as typeof fetch;
	const { ModelControl } = await import("../components/model-picker.tsx");
	const composer = field("composer");
	const host = mountHost();
	await act(async () => { root!.render(<ModelControl />); });
	typingMidText(composer);
	await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-open-model-picker")); });
	const menu = document.querySelector<HTMLElement>('[data-testid="model-menu"]');
	assert.ok(menu, "⌘K opened the menu");
	(menu.querySelector("input") ?? menu).focus(); // MenuShell's focus once placed
	await escape();
	assert.equal(document.querySelector('[data-testid="model-menu"]'), null);
	assert.ok(caretMidText(composer), "back in the field, caret where it was");
	assert.ok(host.isConnected);
});

const provider = { id: "openrouter", envVar: "OPENROUTER_API_KEY", label: "OpenRouter" };
const model = {
	id: "fixture-text", name: "Fixture", provider: provider.id, reasoning: false, input: ["text"],
	supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
};
let keyed = false;
async function mountSetup() {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		assert.equal(init?.method ?? "GET", "GET", "no writes");
		const path = new URL(String(input), "http://localhost").pathname;
		if (path === "/api/keys") return Response.json({ providers: [provider], keys: [] });
		return Response.json({ providers: [{ ...provider, keyPresent: keyed }], models: keyed ? [model] : [], slots: { strong: null, cheap: null, vision: null } });
	}) as typeof fetch;
	const { SetupDialog } = await import("../components/setup-dialog.tsx");
	function Harness() {
		const [open, setOpen] = React.useState(true);
		return <SetupDialog open={open} onClose={() => setOpen(false)} onDone={() => setOpen(false)} />;
	}
	mountHost();
	await act(async () => { root!.render(<Harness />); });
	await frame();
}

it("setup opened by a failed answer submit (nothing focused) closes into Your thinking", async () => {
	keyed = true;
	const thinking = field("thinking-field"); // remounted by the submit: focus is on the body
	await mountSetup();
	assert.ok(document.querySelector('[data-testid="setup-dialog"]'));
	await escape();
	assert.equal(document.querySelector('[data-testid="setup-dialog"]'), null);
	assert.ok(caretAtEnd(thinking), "focus is in Your thinking, not on the body");
});

it("a saved key moves focus to the first model picker; closing then goes to the composer", async () => {
	keyed = false;
	const composer = field("composer");
	const pill = document.createElement("button");
	pill.setAttribute("data-testid", "setup-cta-keys");
	document.body.append(pill);
	hosts.push(pill);
	pill.focus();
	await mountSetup();
	assert.ok(document.querySelector('[data-testid="setup-stage-keys"]'));
	focused = null; // the key form that held focus is replaced
	keyed = true;
	const { notifySettingsSaved } = await import("../components/settings-signal.ts");
	await act(async () => { notifySettingsSaved("keys"); });
	await frame();
	assert.ok(document.querySelector('[data-testid="setup-stage-pickers"]'));
	assert.ok(focused === document.querySelector('[data-testid="setup-trigger-strong"]'), "focus is on the Strong picker");
	pill.remove(); // a key retires the pill
	await escape();
	assert.equal(document.querySelector('[data-testid="setup-dialog"]'), null);
	assert.ok(caretAtEnd(composer), "the opener is gone: focus goes to the composer");
});
