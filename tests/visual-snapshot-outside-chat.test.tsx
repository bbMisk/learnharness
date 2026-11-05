/** Merge review (upstream v0.5.0 into the fork): the fork's activity dock
 *  previews a visual job outside any chat page, so an annotated learner image
 *  must be loaded with the job's own chat id. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { VisualOutputCard } = await import("../components/artifacts/visual-card.tsx");

it("an annotated image outside a chat page loads from the job's chat", async () => {
	const requested: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		requested.push(String(url));
		return new Response(JSON.stringify({ mimeType: "image/png", data: "AAAA", width: 4, height: 3 }), { status: 200 });
	}) as typeof fetch;
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		const output = { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 4 3\"></svg>", image: { snapshotId: "snap1" } };
		await act(async () => root.render(<VisualOutputCard output={output} chatId="chat_job" />));
		await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
		assert.deepEqual(requested, ["/api/chats/chat_job/images/snap1"]);
		assert.doesNotMatch(host.textContent ?? "", /could not be loaded/);
	} finally {
		await act(async () => root.unmount());
		globalThis.fetch = realFetch;
	}
});
