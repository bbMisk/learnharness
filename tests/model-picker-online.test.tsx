/** QA r2 robust #3: a settings read that failed while the network was down
 *  is retried when the browser comes back online. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: { getItem: () => null, setItem() {} },
});
const { ModelControl } = await import("../components/model-picker.tsx");

let root: Root | undefined;
const realFetch = globalThis.fetch;
afterEach(async () => {
	await act(async () => root?.unmount());
	globalThis.fetch = realFetch;
});

it("the model pill fills in once the browser is back online", async () => {
	let online = false;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		if (!online) throw new TypeError("Failed to fetch");
		if (input === "/api/models") return Response.json({ models: [], providers: [], slots: {}, defaults: {} });
		if (input === "/api/settings") return Response.json({ settings: { models: { strong: { model: { provider: "chatgpt", id: "gpt-5" } } } } });
		throw new Error(`unexpected request ${input}`);
	}) as typeof fetch;
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<ModelControl />));
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
	const pill = () => document.querySelector<HTMLElement>('[data-testid="stats-model"]')!.textContent ?? "";
	assert.doesNotMatch(pill(), /gpt/i, "the read failed while offline");
	online = true;
	await act(async () => {
		window.dispatchEvent(new Event("online"));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	assert.match(pill(), /gpt/i);
});
