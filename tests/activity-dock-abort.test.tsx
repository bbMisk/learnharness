/** The dock's End: a stopped run's state leaves with its row, so a later run
 * with the same id (re-extracting one source) gets a live End again. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent, Event: dom.window.Event, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0), cancelAnimationFrame: (id: number) => clearTimeout(id),
});
const { createRoot } = await import("react-dom/client");
const { ActivitySection } = await import("../components/activity-dock.tsx");

it("ending an extraction does not leave End disabled for the next run of the same source", async () => {
	const fetches: string[] = [];
	const get = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => { fetches.push(String(input)); return Response.json({ ok: true }); }) as typeof fetch;
	const running = { jobs: [], extractions: [{ id: "src_a", chatId: "src_a", title: "Notes", phase: "merging", startedAt: Date.now() - 5000 }] };
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const end = () => host.querySelector<HTMLButtonElement>('[data-testid="activity-abort"]');
	try {
		await act(async () => root.render(<ActivitySection feed={running} />));
		await act(async () => { end()!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		assert.equal(fetches.length, 1);
		assert.equal(end()!.disabled, true, "stopping");
		await act(async () => root.render(<ActivitySection feed={{ jobs: [], extractions: [] }} />)); // the run ended
		await act(async () => root.render(<ActivitySection feed={running} />)); // re-extracted
		assert.equal(end()!.disabled, false, "the new run can be ended");
	} finally {
		await act(async () => root.unmount());
		host.remove();
		globalThis.fetch = get;
	}
});
