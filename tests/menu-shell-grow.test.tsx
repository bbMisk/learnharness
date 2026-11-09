/** MenuShell re-decides its side when content that loads after it opened no
 * longer fits (the chat row menu's coverage block). */
import React, { act, useRef, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const frames: FrameRequestCallback[] = [];
Object.assign(dom.window, { innerWidth: 1440, innerHeight: 900 });
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => frames.push(cb), cancelAnimationFrame: () => {},
});
const { createRoot } = await import("react-dom/client");
const { MenuShell } = await import("../components/menu-shell.tsx");

// The menu's box as a browser lays it out: content height, capped by max-height.
let content = 230;
const menuEl = (el: Element) => el.getAttribute("data-testid") === "row-menu";
const cap = (el: Element) => Number.parseFloat((el as HTMLElement).style.maxHeight) || Infinity;
const proto = dom.window.HTMLElement.prototype;
Object.defineProperty(proto, "scrollHeight", { configurable: true, get(this: Element) { return menuEl(this) ? content : 0; } });
Object.defineProperty(proto, "clientHeight", { configurable: true, get(this: Element) { return menuEl(this) ? Math.min(content, cap(this)) : 0; } });
// A DOMRect-shaped anchor (prototype getters): a sidebar row low in the window.
class Rect { get top() { return 630; } get bottom() { return 656; } get left() { return 12; } get right() { return 270; } }
proto.getBoundingClientRect = () => new Rect() as DOMRect;

let grow!: () => void;
function Row() {
	const [more, setMore] = useState(false);
	grow = () => setMore(true);
	const anchor = useRef(document.querySelector<HTMLElement>("#row"));
	return <MenuShell anchorRef={anchor} testid="row-menu" preferredSide="down" align="left" menuClass="">
		<button type="button">Rename</button>
		{more && <section>Coverage · Extract</section>}
	</MenuShell>;
}

it("content that grows past the cap after opening flips the menu to the roomier side", async () => {
	document.body.innerHTML = '<button id="row"></button><div id="host"></div>';
	const root = createRoot(document.querySelector("#host")!);
	try {
		await act(async () => root.render(<Row />));
		const menu = () => document.querySelector<HTMLElement>('[data-testid="row-menu"]')!;
		assert.equal(menu().style.top, "660px", "fits below at first: opens down");
		content = 304;
		await act(async () => { grow(); await Promise.resolve(); });
		await act(async () => { for (const cb of frames.splice(0)) cb(0); });
		assert.equal(menu().style.top, "", "no longer anchored below");
		assert.equal(menu().style.bottom, `${900 - 630 + 4}px`, "flipped up, above the row");
		assert.ok(cap(menu()) >= 304, "and shows the whole content");
	} finally {
		await act(async () => root.unmount());
	}
});
