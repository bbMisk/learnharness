import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { assertSameNode } from "./helpers/same-node.ts";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import { AUTH_KEYS, type AuthKeyStatus } from "../src/core/index.ts";

// A key row's rejected paste: focus stays in the field, and folding the
// editor drops the error (the saved key is fine).
const dom = parseHTML("<html><body><div id='root'></div></body></html>");
Object.assign(dom.document, { oninput: null });
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 900 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
	cancelAnimationFrame: clearTimeout,
});
const { createRoot } = await import("react-dom/client");
const { KeysSection } = await import("../components/settings/keys-section.tsx");

const realFetch = globalThis.fetch;
const deletes: string[] = [];
const keys: AuthKeyStatus[] = [{
	id: "DEEPGRAM_API_KEY", info: AUTH_KEYS.find((key) => key.id === "DEEPGRAM_API_KEY")!,
	present: true, masked: "…test (32 chars)", source: "file", shadowedByEnv: false,
}];
let root: Root | null = null;
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (element: HTMLElement | null) => { assert.ok(element); await act(async () => { element.click(); }); };

afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = null;
	globalThis.fetch = realFetch;
	deletes.length = 0;
});

async function mount() {
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (init?.method === "DELETE") { deletes.push(url); return Response.json({ ok: true }); }
		if (url === "/api/keys") return Response.json({ keys, providers: [{ id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" }] });
		if (url === "/api/custom-provider") return Response.json({ baseUrl: "", authMode: "keyless", models: [] });
		return Response.json({});
	}) as typeof fetch;
	root = createRoot(document.getElementById("root")!);
	await act(async () => { root!.render(<KeysSection />); });
}

async function type(element: HTMLInputElement, value: string) {
	Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(element, value);
	await act(async () => { element.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
}
const enter = (element: HTMLElement) => act(async () => {
	element.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter" }));
	await new Promise((resolve) => setTimeout(resolve, 5));
});

/** A rejected paste in a key row: the error shows while the editor is open,
 *  and folding it (Cancel or Esc) drops the error with it, since the saved
 *  key is fine. The field keeps focus after the rejection. */
test("a key row's rejection keeps focus in the field and clears on Cancel or Esc", async () => {
	await mount();
	const realFetchFn = globalThis.fetch;
	globalThis.fetch = (async (url: string, init?: RequestInit) => init?.method === "PUT"
		? Response.json({ error: "A key can't contain spaces or line breaks" }, { status: 400 })
		: realFetchFn(url, init)) as typeof fetch;
	for (const fold of ["cancel", "escape"] as const) {
		await click(byTest("key-deepgram_api_key-row"));
		const input = byTest("key-deepgram_api_key-input") as HTMLInputElement;
		await type(input, "bad key");
		let focused: Element | null = null;
		input.focus = () => { focused = input; };
		await enter(input);
		assert.equal(byTest("key-deepgram_api_key-error")?.textContent, "A key can't contain spaces or line breaks");
		assertSameNode(focused, input, "the re-enabled field takes focus back");
		if (fold === "cancel") await click(byTest("key-deepgram_api_key-cancel"));
		else await act(async () => { document.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" })); });
		assertSameNode(byTest("key-deepgram_api_key-editor"), null, `${fold} folds the editor`);
		assertSameNode(byTest("key-deepgram_api_key-error"), null, `${fold} drops the error`);
	}
});
