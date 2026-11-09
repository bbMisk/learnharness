import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
	Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, self: globalThis,
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
});
const { createRoot } = await import("react-dom/client");
const { GraphChromeRow } = await import("../components/graph-view.tsx");
const { DEFAULT_RENDER_SETTINGS } = await import("../src/core/render-settings.ts");

/** Esc in the node search clears it; on an empty search it leaves the field.
 *  Either way the key is claimed, so the window Esc chain doesn't also act. */
it("Esc clears the graph search, then leaves it", async () => {
	const queries: string[] = [];
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const render = (query: string) => root.render(
		<GraphChromeRow isEmpty={false} query={query} onQuery={(q) => queries.push(q)} noMatch={false} importing={false}
			searchInputRef={{ current: null }} onImportFiles={() => {}} settings={DEFAULT_RENDER_SETTINGS as never}
			changeSettings={() => {}} onOpenChains={() => {}} onFit={() => {}} />,
	);
	const esc = async () => {
		const input = host.querySelector('input[aria-label="Search nodes"]') as HTMLInputElement;
		let blurred = false;
		input.blur = () => { blurred = true; };
		const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" });
		let reachedWindow = false;
		const onWindow = () => { reachedWindow = true; };
		window.addEventListener("keydown", onWindow);
		await act(async () => input.dispatchEvent(event));
		window.removeEventListener("keydown", onWindow);
		return { blurred, claimed: event.defaultPrevented && !reachedWindow };
	};
	try {
		await act(async () => render("Relational"));
		assert.deepEqual(await esc(), { blurred: false, claimed: true });
		assert.deepEqual(queries, [""]);
		await act(async () => render(""));
		assert.deepEqual(await esc(), { blurred: true, claimed: true });
		assert.deepEqual(queries, [""]);
	} finally {
		await act(async () => root.unmount());
	}
});
