import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
globalThis.fetch = (async () => Response.json({ settings: { general: {} } })) as typeof fetch;
const { useSessionMode } = await import("../components/session-modes.ts");

/** /chat/new?mode=… re-renders the same page: the sidebar's Teaching and
 *  Practice must change the draft's mode, and the in-page switch still works. */
test("the new-session mode follows the requested mode", async () => {
	let state!: ReturnType<typeof useSessionMode>;
	function Draft({ mode }: { mode: "teach" | "practice" }) {
		state = useSessionMode(mode);
		return null;
	}
	const root = createRoot(document.createElement("div"));
	try {
		await act(async () => root.render(<Draft mode="teach" />));
		assert.equal(state[0], "teach");
		await act(async () => root.render(<Draft mode="practice" />));
		assert.equal(state[0], "practice");
		await act(async () => state[1]("teach"));
		assert.equal(state[0], "teach");
		await act(async () => root.render(<Draft mode="practice" />));
		assert.equal(state[0], "teach", "an unchanged request keeps the switch's choice");
		await act(async () => root.render(<Draft mode="teach" />));
		assert.equal(state[0], "teach");
	} finally {
		await act(async () => root.unmount());
	}
});
