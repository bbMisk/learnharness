/** Touch screens get no Hint tooltips (a focus restore popped a desktop
 *  hint on the phone, and its Esc layer swallowed the drawer's Esc). */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let touch = true;
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, { matchMedia: (q: string) => ({ matches: q === "(hover: none)" && touch, addEventListener() {}, removeEventListener() {} }) });

const { createRoot } = await import("react-dom/client");
const { Hint } = await import("../components/ui/hint.tsx");

async function focusState(): Promise<string | null> {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(<Hint label="Settings"><button type="button" data-testid="t">S</button></Hint>));
	const button = host.querySelector('[data-testid="t"]')!;
	await act(async () => button.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })));
	await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
	const state = button.getAttribute("data-state");
	await act(async () => root.unmount());
	host.remove();
	return state;
}

it("a focus on a touch screen opens no tooltip; with hover it still does", async () => {
	touch = true;
	assert.equal(await focusState(), "closed");
	touch = false;
	assert.notEqual(await focusState(), "closed");
});
