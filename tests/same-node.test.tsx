import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { assertNotSameNode, assertSameNode } from "./helpers/same-node.ts";

// A failing node compare names the nodes in a short message: assert.equal
// would print React-mounted linkedom nodes and grow without bound.
const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true, self: globalThis });
const { createRoot } = await import("react-dom/client");

it("a failing node compare throws a short message naming both nodes", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(<div><span data-testid="a">a</span><button aria-label="Close">b</button></div>));
	const a = host.querySelector("span"), b = host.querySelector("button");
	assertSameNode(a, a);
	assertNotSameNode(a, b);
	assert.throws(() => assertSameNode(a, b, "focus"), { message: 'focus: expected <button aria-label="Close">, got <span data-testid="a">' });
	assert.throws(() => assertSameNode(a, null), { message: 'expected null, got <span data-testid="a">' });
	assert.throws(() => assertNotSameNode(b, b), { message: 'expected a node other than <button aria-label="Close">' });
	await act(async () => root.unmount());
});
