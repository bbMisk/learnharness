/** Chains with the server down shows the app's wording, never fetch's raw "Failed to fetch". */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(dom.document, { oninput: null });
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	MutationObserver: dom.window.MutationObserver, NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
	fetch: async () => { throw new TypeError("Failed to fetch"); },
});
// HostDialog's scroll lock measures the page; linkedom has no layout.
const style = (element: HTMLElement) => ({
	display: element.style.display || "block", visibility: element.style.visibility || "visible",
	paddingLeft: "0px", paddingRight: "0px", marginLeft: "0px", marginRight: "0px", borderLeftWidth: "0px", borderRightWidth: "0px",
	getPropertyValue: () => "",
});
Object.assign(dom.window, { getComputedStyle: style });
dom.window.HTMLElement.prototype.focus = function () {};
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
Object.assign(dom.window.HTMLElement.prototype, { select() {} });

const { createRoot } = await import("react-dom/client");
const { ChainTableOverlay } = await import("../components/chain-table.tsx");
const { EditableSourceName } = await import("../components/source-folder-tree.tsx");
const { DeleteSourceDialog } = await import("../components/delete-source-dialog.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const quiet = () => ({ close() {}, onOpen() {}, onEvent() {} });

async function mount(node: React.ReactNode) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(<InteractionLayersProvider><ServerEventsProvider connect={quiet}>{node}</ServerEventsProvider></InteractionLayersProvider>));
	return { root, host };
}

it("opening the table with the server down", async () => {
	const { root } = await mount(<ChainTableOverlay open nodes={[]} chains={[]} sessions={{}} fileSources={{}} onClose={() => {}} />);
	await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
	const text = document.body.textContent ?? "";
	await act(async () => root.unmount());
	assert.doesNotMatch(text, /Failed to fetch/);
	assert.match(text, /Could not read source organization\./);
});

it("a source rename that never reaches the server", async () => {
	const { root, host } = await mount(<EditableSourceName name="LEC 3" onSave={() => fetch("/x")} initiallyEditing />);
	const input = host.querySelector('[data-testid="source-name-input"]') as HTMLInputElement;
	await act(async () => input.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter" })));
	const alert = host.querySelector('[role="alert"]')?.textContent;
	await act(async () => root.unmount());
	assert.equal(alert, "Could not save the name. Try again.");
});

it("a source delete that never reaches the server", async () => {
	const { root } = await mount(<DeleteSourceDialog open sources={[]} folders={[]} onDelete={async () => { await fetch("/x"); }} onClose={() => {}} />);
	await act(async () => (document.querySelector('[data-testid="source-delete-confirm"]') as HTMLElement).dispatchEvent(new dom.window.Event("click", { bubbles: true })));
	const alert = document.querySelector('[data-testid="source-delete-failure"]')?.textContent;
	await act(async () => root.unmount());
	assert.equal(alert, "Could not delete sources.");
});
