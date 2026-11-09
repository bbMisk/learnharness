import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import { AUTH_KEYS, type AuthKeyStatus } from "../src/core/index.ts";

// Keys section paper cuts: a stored key deletes only on a second click, and
// a key-format error wraps under the paste field instead of squeezing it.
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

test("deleting a stored key asks for a second click", async () => {
	await mount();
	await click(byTest("key-deepgram_api_key-row"));
	const del = byTest("key-deepgram_api_key-delete");
	await click(del);
	assert.deepEqual(deletes, [], "one click only arms the delete");
	assert.equal(byTest("key-deepgram_api_key-delete")?.textContent, "Confirm delete");
	await click(byTest("key-deepgram_api_key-delete"));
	assert.deepEqual(deletes, ["/api/keys/DEEPGRAM_API_KEY"]);
});

test("the add-provider editor row wraps so an error sits under the input", async () => {
	await mount();
	await click(byTest("add-provider"));
	await click(byTest("provider-option-openai"));
	assert.match(byTest("key-openai-editor")?.className ?? "", /\bflex-wrap\b/);
});
