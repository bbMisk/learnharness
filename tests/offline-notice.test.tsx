/** QA r2 robust #4: the can't-reach-server notice shows as soon as the events
 *  channel drops (not only once a navigation fails), and clears when it
 *  reconnects. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { OfflineNotice } = await import("../components/offline-notice.tsx");

let root: Root | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
});

it("the notice follows the events channel: shown when it drops, gone when it reopens", async () => {
	let open = () => {};
	let error = () => {};
	const channel = () => ({
		close() {},
		onOpen(cb: () => void) {
			open = cb;
		},
		onEvent() {},
		onError(cb: () => void) {
			error = cb;
		},
	});
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<ServerEventsProvider connect={channel}>
				<OfflineNotice />
			</ServerEventsProvider>,
		),
	);
	const notice = () => host.querySelector('[data-testid="offline-notice"]');
	await act(async () => open());
	assert.equal(notice(), null);
	await act(async () => error());
	assert.match(notice()?.textContent ?? "", /Can.t reach the server/);
	assert.doesNotMatch(notice()?.className ?? "", /top-/, "kept off the transcript's top edge");
	await act(async () => open());
	assert.equal(notice(), null);
});
