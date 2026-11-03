/** The practice metadata popover closes on outside scroll/resize but not when it scrolls itself (round-9 hunt). */
import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";

const { window, document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { React, window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, Event: window.Event, CustomEvent: window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, innerWidth: 852, innerHeight: 393 });
const { createRoot } = await import("react-dom/client");
const { ConcludeCard, scrollClosesPopover } = await import("../components/practice-cards.tsx");
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
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(<ConcludeCard part={part} />));
	const open = async () => {
		await act(async () => (document.querySelector('[data-testid="metadata-toggle"]') as HTMLElement).click());
		assert.ok(document.querySelector('[data-testid="metadata-box"]'), "opened");
	};
	await open();
	const box = document.querySelector('[data-testid="metadata-box"]')!;
	await act(async () => { box.dispatchEvent(new window.Event("scroll")); });
	assert.ok(document.querySelector('[data-testid="metadata-box"]'), "its own scroll does not close it");
	await act(async () => { document.body.dispatchEvent(new window.Event("scroll")); window.dispatchEvent(new window.Event("scroll")); });
	assert.equal(document.querySelector('[data-testid="metadata-box"]'), null, "an outside scroll closes it");
	await open();
	await act(async () => { window.dispatchEvent(new window.Event("resize")); });
	assert.equal(document.querySelector('[data-testid="metadata-box"]'), null, "a resize closes it");
	await act(async () => root.unmount());
});

test("the scroll rule: inside the box keeps it open, anything else closes it", () => {
	const box = document.createElement("div");
	const inner = document.createElement("p");
	box.append(inner);
	document.body.append(box);
	assert.equal(scrollClosesPopover(box, box), false);
	assert.equal(scrollClosesPopover(inner, box), false);
	assert.equal(scrollClosesPopover(document.body, box), true);
	assert.equal(scrollClosesPopover(document, box), true);
	assert.equal(scrollClosesPopover(null, box), true);
	assert.equal(scrollClosesPopover(inner, null), true, "no box yet: close");
});
