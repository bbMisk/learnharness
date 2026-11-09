/** The practice metadata popover closes on outside scroll/resize but not when it scrolls itself */
import React, { act } from "react";
import assert from "node:assert/strict";
import { assertSameNode } from "./helpers/same-node.ts";
import { test } from "node:test";
import { parseHTML } from "linkedom";

const { window, document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { React, window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, Event: window.Event, CustomEvent: window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, innerWidth: 852, innerHeight: 393 });
const { createRoot } = await import("react-dom/client");
const { ConcludeCard } = await import("../components/practice-cards.tsx");
import type { ArtifactPartProps } from "../src/core";

const part = {
	type: "tool-conclude",
	toolCallId: "c1",
	state: "output-available",
	input: { outcome: "solvedWithHints", verdict: "v", rung: "R2", missClass: "cue", retest: true },
	problemInput: { mode: "discrimination", target: ["n_abc"] },
	reveal: "The solution.",
} as unknown as ArtifactPartProps["part"];

test("scrolling inside the open popover keeps it open; an outside scroll or a resize closes it", async () => {
	// linkedom does not propagate element events to window, so drive the
	// popover's capture-phase window scroll listener directly with a target.
	const scrollListeners: EventListener[] = [];
	const add = window.addEventListener.bind(window);
	window.addEventListener = ((type: string, listener: EventListener, options?: unknown) => {
		if (type === "scroll") scrollListeners.push(listener);
		return add(type, listener, options as AddEventListenerOptions);
	}) as typeof window.addEventListener;
	const scroll = (target: EventTarget) => act(async () => { scrollListeners.at(-1)!({ target } as unknown as Event); });
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(<ConcludeCard part={part} />));
		const open = async () => {
			await act(async () => (document.querySelector('[data-testid="metadata-toggle"]') as HTMLElement).click());
			assert.ok(document.querySelector('[data-testid="metadata-box"]'), "opened");
		};
		await open();
		const box = document.querySelector('[data-testid="metadata-box"]')!;
		await scroll(box);
		await scroll(box.querySelector("dl")!);
		assert.ok(document.querySelector('[data-testid="metadata-box"]'), "its own scroll does not close it");
		await scroll(document.body);
		assertSameNode(document.querySelector('[data-testid="metadata-box"]'), null, "an outside scroll closes it");
		await open();
		await scroll(document);
		assertSameNode(document.querySelector('[data-testid="metadata-box"]'), null, "a document scroll closes it");
		await open();
		await act(async () => { window.dispatchEvent(new window.Event("resize")); });
		assertSameNode(document.querySelector('[data-testid="metadata-box"]'), null, "a resize closes it");
	} finally {
		window.addEventListener = add;
		await act(async () => root.unmount());
	}
});
