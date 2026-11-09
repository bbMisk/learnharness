import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { ModelInstructionsSection } from "../components/settings/model-instructions-section.tsx";
import type { ModelCatalogEntry } from "../src/core/index.ts";

it("saving another Agent setting keeps an unsaved model-instructions draft", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	const catalog = [{ id: "opus", name: "Opus", provider: "claude-code" }] as ModelCatalogEntry[];
	// A fresh (equal) settings object each render, as after saving any other setting.
	const render = () => root.render(<ModelInstructionsSection agent={{ modelInstructions: {} }} catalog={catalog} onChange={() => {}} />);
	try {
		await act(async () => render());
		act(() => document.querySelector<HTMLButtonElement>('[data-testid="model-instructions-suggest"]')!.click());
		const draft = document.querySelector<HTMLTextAreaElement>('[data-testid="model-instructions-text"]')!.value;
		assert.match(draft, /^Slow down\./);
		await act(async () => render());
		assert.equal(document.querySelector<HTMLTextAreaElement>('[data-testid="model-instructions-text"]')!.value, draft);
	} finally {
		act(() => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
});

it("an unsaved draft survives switching models and closing Settings", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	let root = createRoot(document.getElementById("root")!);
	const catalog = [{ id: "opus", name: "Opus", provider: "anthropic" }, { id: "gpt-5", name: "GPT-5", provider: "openai" }] as ModelCatalogEntry[];
	const render = () => root.render(<ModelInstructionsSection agent={{ modelInstructions: {} }} catalog={catalog} onChange={() => {}} />);
	const text = () => document.querySelector<HTMLTextAreaElement>('[data-testid="model-instructions-text"]')!.value;
	const pick = (key: string) => act(() => {
		const select = document.querySelector<HTMLSelectElement>('[data-testid="model-instructions-model"]')!;
		for (const option of select.querySelectorAll("option")) option.toggleAttribute("selected", option.getAttribute("value") === key);
		select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
	});
	try {
		await act(async () => render());
		pick("anthropic:opus");
		act(() => document.querySelector<HTMLButtonElement>('[data-testid="model-instructions-suggest"]')!.click());
		const draft = text();
		assert.ok(draft.length > 0);
		pick("openai:gpt-5");
		assert.notEqual(text(), draft);
		pick("anthropic:opus");
		assert.equal(text(), draft, "switching back restores the draft");
		act(() => root.unmount());
		root = createRoot(document.getElementById("root")!);
		await act(async () => render());
		pick("anthropic:opus");
		assert.equal(text(), draft, "reopening Settings restores the draft");
	} finally {
		act(() => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
});

it("with nothing saved, the picker starts on the Strong model", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({ window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	const catalog = [{ id: "fable", name: "Claude Fable", provider: "anthropic" }, { id: "gpt-5", name: "GPT-5", provider: "openai" }] as ModelCatalogEntry[];
	try {
		await act(async () => root.render(<ModelInstructionsSection agent={{ modelInstructions: {} }} catalog={catalog} strong={{ provider: "openai", id: "gpt-5" }} onChange={() => {}} />));
		const selected = document.querySelector<HTMLSelectElement>('[data-testid="model-instructions-model"]')!.querySelector("option[selected]") ?? null;
		const value = document.querySelector<HTMLSelectElement>('[data-testid="model-instructions-model"]')!.value;
		assert.equal(value || selected?.getAttribute("value"), "openai:gpt-5");
	} finally {
		act(() => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
});
