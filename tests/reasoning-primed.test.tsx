import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "../components/ai-elements/reasoning.tsx";

it("a closed thinking row mounts its content only once its trigger is hovered or focused", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const raf = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number;
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.document,
		HTMLElement: dom.window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: raf,
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		getComputedStyle: () => ({ animationName: "none", display: "block", getPropertyValue: () => "" }),
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	const content = () => document.querySelector('[data-slot="collapsible-content"]');
	try {
		await act(async () => root.render(<Reasoning><ReasoningTrigger /><ReasoningContent>Hidden steps.</ReasoningContent></Reasoning>));
		assert.equal(content(), null, "closed and untouched: nothing mounted");

		const trigger = document.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!;
		await act(async () => { trigger.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })); });
		assert.ok(content(), "focus mounts the content");
		assert.equal(content()!.getAttribute("data-state"), "closed", "still closed, so the open animation can play");
		assert.ok(!content()!.textContent?.includes("Hidden steps."));

		await act(async () => trigger.click());
		assert.equal(content()!.getAttribute("data-state"), "open");
		assert.ok(content()!.textContent?.includes("Hidden steps."));
	} finally {
		act(() => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
});
