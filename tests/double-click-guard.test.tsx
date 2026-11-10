/** App-wide: the second click of a double click never reaches a control. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { useDoubleClickGuard } = await import("../components/double-click-tail.ts");

it("drops a click with detail > 1 on controls only, and only while mounted", async () => {
	function Guard() { useDoubleClickGuard(); return <><button id="b"><span id="inner">Confirm</span></button><button id="zoom" data-lh-repeat>+</button><p id="text">words</p></>; }
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const click = (id: string, detail: number) => {
		const event = Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail });
		document.getElementById(id)!.dispatchEvent(event);
		return event.defaultPrevented;
	};
	try {
		await act(async () => root.render(<Guard />));
		assert.equal(click("b", 2), true, "a double click's second click on a button");
		assert.equal(click("inner", 2), true, "inside a button too");
		assert.equal(click("b", 1), false, "single clicks are untouched");
		assert.equal(click("text", 2), false, "plain text keeps its double click");
		assert.equal(click("zoom", 2), false, "a stepping control (zoom, Find next) keeps fast repeats");
		await act(async () => root.render(null));
		document.body.innerHTML = '<button id="b"></button>';
		assert.equal(click("b", 2), false, "no guard once unmounted");
	} finally {
		await act(async () => root.unmount());
	}
});
