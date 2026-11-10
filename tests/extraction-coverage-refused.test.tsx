/** The row menu's Extract: a run the server refuses at once (no model, a
 * removed key) must not leave the block on "Running", polling forever. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent, Event: dom.window.Event, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { CoverageMenuBlock } = await import("../components/extraction-coverage.tsx");

it("a run refused right after its 202 stands the Running state down", async () => {
	const coverage = { totalMessages: 12, coveredCount: 7, uncoveredCount: 5, coveredTokens: 30_000, uncoveredTokens: 2_048, running: false, lastFoldedAt: null };
	const get = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		init?.method === "POST" ? Response.json({ ok: true }, { status: 202 }) : Response.json({ coverage })) as typeof fetch;
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const extract = () => host.querySelector<HTMLButtonElement>('[data-testid="ctx-extract"]')!;
	try {
		await act(async () => root.render(<CoverageMenuBlock chatId="c1" />));
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		assert.equal(extract().textContent?.trim(), "Extract");
		await act(async () => { extract().dispatchEvent(new dom.window.Event("click", { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
		assert.equal(extract().textContent?.trim(), "Extract", "the server never said running: no endless Running");
	} finally {
		await act(async () => root.unmount());
		host.remove();
		globalThis.fetch = get;
	}
});
