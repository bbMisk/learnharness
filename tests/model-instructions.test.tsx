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
