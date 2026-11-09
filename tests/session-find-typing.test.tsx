/** Find on long sessions: typing reuses the session's displayed-text index
 * (QA: 160–530 ms per keystroke when every key re-walked the transcript). */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><head></head><body></body></html>");
const frames: FrameRequestCallback[] = [];
// The DOM walk's cost is one computed-style read per element.
let styleReads = 0;
Object.assign(dom.window, {
	requestAnimationFrame: (cb: FrameRequestCallback) => frames.push(cb),
	cancelAnimationFrame: () => {},
	getComputedStyle: () => {
		styleReads++;
		return { display: "block", visibility: "visible", opacity: "1", whiteSpace: "normal" };
	},
});
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	MutationObserver: dom.window.MutationObserver,
	Event: dom.window.Event,
	CSS: { highlights: new Map() },
	IS_REACT_ACT_ENVIRONMENT: true,
});
// React listens for input events only when the document advertises oninput.
Object.assign(dom.document, { oninput: null });
// linkedom has no focus or text selection.
Object.assign(dom.window.HTMLElement.prototype, { focus() {}, select() {} });
// Nor a default input type; React only tracks typing into text-like inputs.
Object.defineProperty(dom.window.HTMLInputElement.prototype, "type", {
	configurable: true,
	get(this: Element) { return this.getAttribute("type") ?? "text"; },
});
const { createRoot } = await import("react-dom/client");
const { SessionFind } = await import("../components/session-find.tsx");
const { kbdEventForAction } = await import("../src/core/keyboard.ts");

it("a keystroke reads no computed styles; a session change rebuilds the index", async () => {
	const filler = "<p>filler</p>".repeat(100);
	dom.document.body.innerHTML = `<div id="scope"><div data-session-find-root=""><p>chain rule</p><p>chain link</p>${filler}</div></div><div id="bar"></div>`;
	const scope = dom.document.getElementById("scope") as unknown as HTMLDivElement;
	const root = createRoot(dom.document.getElementById("bar") as unknown as HTMLElement);
	try {
		await act(async () => root.render(<SessionFind scopeRef={{ current: scope }} scrollContextRef={{ current: null }} />));
		await act(async () => { dom.window.dispatchEvent(new dom.window.Event(kbdEventForAction("find"))); });
		const input = dom.document.querySelector("input") as unknown as HTMLInputElement;
		assert.equal(input.getAttribute("placeholder"), "Find in chat…");
		const type = async (value: string) => {
			Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
			await act(async () => { input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
		};
		const count = () => dom.document.querySelector('[data-testid="session-find-count"]')!.textContent;
		await type("ch");
		assert.equal(count(), "1/2");
		assert.ok(styleReads > 100, "the first query walks the session");
		styleReads = 0;
		await type("cha");
		await type("chain r");
		assert.equal(count(), "1/1");
		// Only the scroll to the first match reads its few ancestors.
		assert.ok(styleReads < 10, `later keystrokes search the cached index (${styleReads} style reads)`);
		const p = dom.document.createElement("p");
		p.textContent = "chain rule again";
		await act(async () => { scope.firstElementChild!.append(p); await Promise.resolve(); });
		await act(async () => { for (const cb of frames.splice(0)) cb(0); });
		assert.equal(count(), "1/2", "new session content is found");
		assert.ok(styleReads > 100, "a session change rebuilds the index");
	} finally {
		await act(async () => root.unmount());
	}
});

it("the index is built while Find sits idle, so even the first keystroke reads no styles", async () => {
	dom.document.body.innerHTML = `<div id="scope"><div data-session-find-root=""><p>chain rule</p>${"<p>filler</p>".repeat(100)}</div></div><div id="bar"></div>`;
	const scope = dom.document.getElementById("scope") as unknown as HTMLDivElement;
	const root = createRoot(dom.document.getElementById("bar") as unknown as HTMLElement);
	try {
		await act(async () => root.render(<SessionFind scopeRef={{ current: scope }} scrollContextRef={{ current: null }} />));
		await act(async () => { dom.window.dispatchEvent(new dom.window.Event(kbdEventForAction("find"))); });
		await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
		styleReads = 0;
		const input = dom.document.querySelector("input") as unknown as HTMLInputElement;
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "ch");
		await act(async () => { input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
		assert.equal(dom.document.querySelector('[data-testid="session-find-count"]')!.textContent, "1/1");
		assert.ok(styleReads < 10, `the first keystroke searches the warmed index (${styleReads} style reads)`);
	} finally {
		await act(async () => root.unmount());
	}
});
