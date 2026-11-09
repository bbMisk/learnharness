import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { assertSameNode } from "./helpers/same-node.ts";
import { after, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChainTableOverlay } from "../components/chain-table.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
const dom = parseHTML("<html><head></head><body></body></html>");
// linkedom omits selection; native browser behavior is covered by the UI check.
dom.window.HTMLInputElement.prototype.select = function () {};
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

it("one Escape cancels inline source/folder editing without closing the overlay (document-root event delegation)", async () => {
	let closed = 0, writes = 0, windowEscapes = 0;
	globalThis.fetch = async (_url, init) => {
		if (init?.method === "POST") writes++;
		return Response.json({ organization: { version: 1, folders: [], placements: {} }, sources: [{ id: "chat", kind: "chat", label: "Unextracted", createdAt: "2026-10-30" }] });
	};
	const root = createRoot(document);
	const onWindow = () => { windowEscapes++; };
	window.addEventListener("keydown", onWindow);
	try {
		await act(async () => { root.render(<html><head /><body><ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
			<ChainTableOverlay open nodes={[]} chains={[]} sessions={{}} fileSources={{}} onClose={() => { closed++; }} />
		</ServerEventsProvider></body></html>); });
		for (const raw of ["null", "3", '"text"', "{"]) {
			const drop = new dom.window.Event("drop", { bubbles: true, cancelable: true });
			Object.defineProperty(drop, "dataTransfer", { value: { getData: () => raw } });
			await act(async () => { document.querySelector('[data-testid="source-root-drop"]')!.dispatchEvent(drop); });
		}
		assert.equal(writes, 0, "malformed drag payloads cannot mutate organization");
		const escape = async () => {
			const input = document.querySelector('[data-testid="source-name-input"]')!;
			assert.ok(input);
			const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true }); Object.defineProperty(event, "key", { value: "Escape" });
			await act(async () => { input.dispatchEvent(event); });
			assertSameNode(document.querySelector('[data-testid="source-name-input"]'), null);
			assert.equal(closed, 0); assert.equal(writes, 0); assert.equal(windowEscapes, 0);
		};
		await act(async () => { (document.querySelector('button[title="Rename"]') as HTMLElement).click(); });
		await escape();
		await act(async () => { (document.querySelector('[data-testid="add-source-folder"]') as HTMLElement).click(); });
		await escape();
		const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true }); Object.defineProperty(event, "key", { value: "Escape" });
		await act(async () => { document.querySelector('[data-testid="chain-table"]')!.dispatchEvent(event); });
		assert.equal(closed, 1, "the next Escape closes the overlay normally"); assert.equal(windowEscapes, 0);
	} finally { await act(async () => { root.unmount(); }); window.removeEventListener("keydown", onWindow); }
});

it("a failed source rename reports once, under its row, and Esc clears it", async () => {
	globalThis.fetch = async (_url, init) => init?.method === "POST"
		? Response.json({ error: "Could not rename." }, { status: 500 })
		: Response.json({ organization: { version: 1, folders: [], placements: {} }, sources: [{ id: "chat", kind: "chat", label: "Unextracted", createdAt: "2026-10-30" }] });
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const alerts = () => [...document.querySelectorAll('[role="alert"]')].filter((el) => el.textContent === "Could not rename.").length;
	const key = (k: string) => { const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true }); Object.defineProperty(event, "key", { value: k }); return event; };
	try {
		await act(async () => { root.render(<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
			<ChainTableOverlay open nodes={[]} chains={[]} sessions={{}} fileSources={{}} onClose={() => {}} />
		</ServerEventsProvider>); });
		await act(async () => { (document.querySelector('button[title="Rename"]') as HTMLElement).click(); });
		const input = document.querySelector<HTMLInputElement>('[data-testid="source-name-input"]')!;
		input.setAttribute("type", "text");
		// react-dom loaded without oninput here: its old-IE path reads value changes between focusin and keyup.
		Object.assign(input, { attachEvent() {}, detachEvent() {} });
		await act(async () => { input.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })); });
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "Renamed");
		await act(async () => { input.dispatchEvent(new dom.window.Event("keyup", { bubbles: true })); });
		await act(async () => { input.dispatchEvent(key("Enter")); });
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
		assert.equal(alerts(), 1, "one error, under the row");
		await act(async () => { document.querySelector('[data-testid="source-name-input"]')!.dispatchEvent(key("Escape")); });
		assert.equal(alerts(), 0, "Esc clears it");
	} finally { await act(async () => { root.unmount(); }); host.remove(); }
});
