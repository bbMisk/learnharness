/** Closing the chain table hands focus back to what opened it. */
import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	fetch: async () => Response.json({ organization: { version: 1, folders: [], placements: {} }, sources: [] }),
});
let focused: Element | undefined;
dom.window.HTMLElement.prototype.focus = function () { focused = this; };
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused ?? document.body });

const { createRoot } = await import("react-dom/client");
const { ChainTableOverlay } = await import("../components/chain-table.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const quiet = () => ({ close() {}, onOpen() {}, onEvent() {} });

let setOpen: (open: boolean) => void = () => {};
function Harness() {
	const [open, update] = useState(false);
	setOpen = update;
	return (
		<>
			<button type="button" data-testid="opener">Chains</button>
			<ChainTableOverlay open={open} nodes={[]} chains={[]} sessions={{}} fileSources={{}} onClose={() => update(false)} />
		</>
	);
}

it("focus returns to the opener after the table closes", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(<ServerEventsProvider connect={quiet}><Harness /></ServerEventsProvider>));
	const opener = document.querySelector<HTMLElement>('[data-testid="opener"]')!;
	opener.focus();
	await act(async () => setOpen(true));
	document.querySelector<HTMLElement>('[data-testid="chain-table-search"]')!.focus();
	await act(async () => setOpen(false));
	const restored = focused === opener;
	await act(async () => root.unmount());
	assert.ok(restored, "focus back on the opener");
});

it("Tab inside the open table stays in it: it goes to the table's search, never the page behind", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(<ServerEventsProvider connect={quiet}><Harness /></ServerEventsProvider>));
	await act(async () => setOpen(true));
	let reachedWindow = false;
	const onWindow = (e: Event) => { if ((e as KeyboardEvent).key === "Tab") reachedWindow = true; };
	window.addEventListener("keydown", onWindow);
	const tab = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Tab" });
	await act(async () => document.querySelector<HTMLElement>('[data-testid="chain-table-overlay"]')!.dispatchEvent(tab));
	window.removeEventListener("keydown", onWindow);
	const onSearch = focused === document.querySelector('[data-testid="chain-table-search"]');
	await act(async () => root.unmount());
	assert.ok(tab.defaultPrevented && !reachedWindow, "the global field cycle never hears it");
	assert.ok(onSearch, "focus lands on the table's search");
});
