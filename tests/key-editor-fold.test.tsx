import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import { AUTH_KEYS, type AuthKeyStatus } from "../src/core/index.ts";

// Folding a key editor (Cancel, Esc, Save) discards its draft and hands
// focus back to the control that opened it.
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
const puts: string[] = [];
const keys: AuthKeyStatus[] = [{
	id: "TAVILY_API_KEY", info: AUTH_KEYS.find((key) => key.id === "TAVILY_API_KEY")!,
	present: false, masked: null, source: null, shadowedByEnv: false,
} as unknown as AuthKeyStatus];
let root: Root | null = null;
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (element: HTMLElement | null) => { assert.ok(element); focused = element; await act(async () => { element.click(); }); };
const escape = () => act(async () => { focused!.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" })); });

afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = null;
	focused = null;
	globalThis.fetch = realFetch;
	puts.length = 0;
});

async function mount() {
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (init?.method === "PUT") { puts.push(JSON.parse(String(init.body)).value); return Response.json({ ok: true }); }
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

async function openTypeFold(fold: "cancel" | "escape") {
	await click(byTest("key-tavily_api_key-row"));
	const input = byTest("key-tavily_api_key-input") as HTMLInputElement;
	focused = input;
	await type(input, "tvly-WRONGKEY");
	if (fold === "cancel") await click(byTest("key-tavily_api_key-cancel"));
	else await escape();
	assert.ok(byTest("key-tavily_api_key-editor") === null, `${fold} folds the editor`);
}

test("a cancelled key draft is gone on reopen, so a new paste is not appended to it", async () => {
	await mount();
	for (const fold of ["cancel", "escape"] as const) {
		await openTypeFold(fold);
		await click(byTest("key-tavily_api_key-row"));
		const input = byTest("key-tavily_api_key-input") as HTMLInputElement;
		assert.equal(input.value, "", `${fold} discards the draft`);
		await type(input, "tvly-RIGHTKEY");
		await act(async () => {
			input.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter" }));
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
		assert.equal(puts.at(-1), "tvly-RIGHTKEY");
	}
});

test("Cancel or Esc in a key row returns focus to the row", async () => {
	await mount();
	for (const fold of ["cancel", "escape"] as const) {
		await openTypeFold(fold);
		assert.ok(document.activeElement === byTest("key-tavily_api_key-row"), `${fold} returns focus to the row`);
	}
});

test("Cancel and Esc in the Add-provider editor return focus to its trigger", async () => {
	await mount();
	for (const fold of ["cancel", "escape"] as const) {
		await click(byTest("add-provider"));
		await click(byTest("provider-option-openai"));
		const input = byTest("key-openai-input");
		assert.ok(input);
		focused = input;
		if (fold === "cancel") await click(byTest("key-openai-cancel"));
		else await escape();
		assert.ok(byTest("key-openai-editor") === null, `${fold} folds the editor`);
		assert.ok(document.activeElement === byTest("add-provider"), `${fold} returns focus to + Add a provider`);
	}
});

test("opening another row leaves focus in that row's field, not on the folded row", async () => {
	keys.push({ id: "DEEPGRAM_API_KEY", info: AUTH_KEYS.find((key) => key.id === "DEEPGRAM_API_KEY")!, present: false, masked: null, source: null, shadowedByEnv: false } as unknown as AuthKeyStatus);
	await mount();
	await click(byTest("key-tavily_api_key-row"));
	focused = byTest("key-tavily_api_key-input");
	await click(byTest("key-deepgram_api_key-row"));
	assert.ok(byTest("key-tavily_api_key-editor") === null);
	assert.ok(document.activeElement === byTest("key-deepgram_api_key-input"), "the new field keeps focus");
	keys.pop();
});
