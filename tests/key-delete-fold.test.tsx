import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import { AUTH_KEYS, type AuthKeyStatus } from "../src/core/index.ts";

// Delete is two clicks, and only ever from a fresh start; a confirmed delete
// folds its row. The custom endpoint editor returns focus like the others.
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
// linkedom has no focus model: the last focus() call holds focus until its element leaves.
let focused: Element | null = null;
dom.window.HTMLElement.prototype.focus = function (this: Element) { focused = this; };
Object.defineProperty(dom.document, "activeElement", { get: () => (focused?.isConnected ? focused : dom.document.body), configurable: true });
const { createRoot } = await import("react-dom/client");
const { KeysSection } = await import("../components/settings/keys-section.tsx");

const realFetch = globalThis.fetch;
const stored = (id: string): AuthKeyStatus => ({
	id, info: AUTH_KEYS.find((key) => key.id === id) ?? null,
	present: true, masked: "…7890 (23 chars)", source: "file", shadowedByEnv: false,
} as unknown as AuthKeyStatus);
let keys: AuthKeyStatus[] = [];
let customBase = "";
let customHold: Promise<void> = Promise.resolve();
let root: Root | null = null;
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const click = async (element: HTMLElement | null) => { assert.ok(element); focused = element; await act(async () => { element.click(); await settle(); }); };
const escape = async () => {
	const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" });
	await act(async () => { (focused?.isConnected ? focused : document.body).dispatchEvent(event); });
	return event;
};

afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = null;
	focused = null;
	globalThis.fetch = realFetch;
	customBase = "";
});

async function mount(initial: string[]) {
	keys = initial.map(stored);
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		const id = url.split("/").pop()!;
		if (init?.method === "DELETE" && url === "/api/custom-provider") { customBase = ""; return Response.json({ ok: true }); }
		if (init?.method === "DELETE") { keys = keys.filter((key) => key.id !== id); return Response.json({ ok: true }); }
		if (init?.method === "PUT") { keys = [...keys.filter((key) => key.id !== id), stored(id)]; return Response.json({ ok: true }); }
		if (url === "/api/keys") return Response.json({ keys, providers: [{ id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" }] });
		if (url === "/api/custom-provider") { await customHold; return Response.json({ baseUrl: customBase, authMode: "keyless", models: [] }); }
		return Response.json({});
	}) as typeof fetch;
	root = createRoot(document.getElementById("root")!);
	await act(async () => { root!.render(<KeysSection />); await settle(); });
}

test("an armed Delete is disarmed when the row folds by Esc or by opening another row", async () => {
	await mount(["TAVILY_API_KEY", "DEEPGRAM_API_KEY"]);
	for (const fold of ["escape", "switch"] as const) {
		await click(byTest("key-tavily_api_key-row"));
		await click(byTest("key-tavily_api_key-delete"));
		assert.equal(byTest("key-tavily_api_key-delete")?.textContent, "Confirm delete");
		if (fold === "escape") await escape();
		else await click(byTest("key-deepgram_api_key-row"));
		assert.ok(byTest("key-tavily_api_key-editor") === null, `${fold} folds the row`);
		await click(byTest("key-tavily_api_key-row"));
		assert.equal(byTest("key-tavily_api_key-delete")?.textContent, "Delete", `${fold}: the reopened row starts from Delete`);
		await escape();
	}
});

test("a confirmed delete folds a built-in row and focus returns to the row", async () => {
	await mount(["TAVILY_API_KEY"]);
	await click(byTest("key-tavily_api_key-row"));
	await click(byTest("key-tavily_api_key-delete"));
	await click(byTest("key-tavily_api_key-delete"));
	assert.ok(byTest("key-tavily_api_key-editor") === null, "the row folds");
	assert.equal(byTest("key-tavily_api_key-status")?.textContent, "not set");
	assert.ok(document.activeElement === byTest("key-tavily_api_key-row"), "focus is on the row");
});

test("deleting an added provider's key focuses + Add a provider, frees Esc, and a re-add comes back folded", async () => {
	await mount(["OPENAI_API_KEY"]);
	await click(byTest("key-openai_api_key-row"));
	await click(byTest("key-openai_api_key-delete"));
	await click(byTest("key-openai_api_key-delete"));
	assert.ok(byTest("key-openai_api_key") === null, "the row is gone");
	assert.ok(document.activeElement === byTest("add-provider"), "focus is on + Add a provider");
	assert.equal((await escape()).defaultPrevented, false, "the next Esc is left to the dialog");

	await click(byTest("add-provider"));
	await click(byTest("provider-option-openai"));
	const input = byTest("key-openai-input") as HTMLInputElement;
	focused = input;
	Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "sk-0123456789abcdefghij");
	await act(async () => { input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
	await act(async () => {
		input.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter" }));
		await settle();
	});
	assert.ok(byTest("key-openai_api_key-row"), "the re-added row is back");
	assert.ok(byTest("key-openai_api_key-editor") === null, "and folded");
	assert.equal(byTest("key-openai_api_key-status")?.textContent, "…7890 · 23");
});

test("Cancel and Esc in the custom endpoint editor return focus to + Add a provider", async () => {
	await mount([]);
	for (const fold of ["cancel", "escape"] as const) {
		await click(byTest("add-provider"));
		await click(byTest("provider-option-custom"));
		const input = byTest("custom-baseurl-input");
		assert.ok(input);
		focused = input;
		if (fold === "cancel") await click(byTest("custom-cancel"));
		else await escape();
		assert.ok(byTest("custom-endpoint-editor") === null, `${fold} folds the editor`);
		assert.ok(document.activeElement === byTest("add-provider"), `${fold} returns focus to + Add a provider`);
	}
});

test("Esc in a configured custom endpoint's editor returns focus to its row", async () => {
	customBase = "http://localhost:11434/v1";
	await mount([]);
	await click(byTest("custom-endpoint-row-btn"));
	focused = byTest("custom-baseurl-input");
	await escape();
	assert.ok(byTest("custom-endpoint-editor") === null);
	assert.ok(document.activeElement === byTest("custom-endpoint-row-btn"));
});

test("disconnecting the custom endpoint focuses + Add a provider and frees Esc", async () => {
	customBase = "http://localhost:11434/v1";
	await mount([]);
	await click(byTest("custom-endpoint-row-btn"));
	await click(byTest("custom-delete"));
	// The endpoint's status re-reads after the key list, in a later render (as in the browser).
	let release = () => {};
	customHold = new Promise((resolve) => { release = resolve; });
	await click(byTest("custom-delete"));
	await act(async () => { release(); await settle(); });
	customHold = Promise.resolve();
	assert.ok(byTest("custom-endpoint-row") === null, "the row is gone");
	assert.ok(byTest("custom-endpoint-editor") === null, "the editor is gone");
	assert.ok(document.activeElement === byTest("add-provider"), "focus is on + Add a provider");
	assert.equal((await escape()).defaultPrevented, false, "the next Esc is left to the dialog");
});
