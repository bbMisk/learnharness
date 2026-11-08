/**
 * THE INVERSION OWNER (components/artifacts/artifact-ui.ts): the demo and
 * figure cards' invert switch updates at once and persists through the
 * silent artifact-ui route — only inside a chat page, only for a steer
 * message id, with a failed write swallowed.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

const { window, document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window, document, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, Event: window.Event });
const { useArtifactInversion } = await import("../components/artifacts/artifact-ui.ts");
const { ChatActionsContext } = await import("../components/chat-actions.ts");

const calls: Array<{ url: string; init: RequestInit }> = [];
let fail = false;
globalThis.fetch = (async (url: string, init: RequestInit) => {
	calls.push({ url, init });
	if (fail) throw new Error("offline");
	return new Response("{}");
}) as typeof fetch;

let root: Root | null = null;
afterEach(async () => {
	if (root) await act(async () => root!.unmount());
	root = null;
	calls.length = 0;
	fail = false;
});

let toggle: (next: boolean) => void = () => {};
function Probe({ messageId, initial }: { messageId?: string; initial?: boolean }) {
	const [inverted, setInverted] = useArtifactInversion(messageId, initial);
	toggle = setInverted;
	return <span data-inverted={String(inverted)} />;
}
const actions = { chatId: "c1", syncFromServer: async () => true, sendText: () => {}, openSetup: () => {} };

async function mount(node: React.ReactNode): Promise<() => string | null> {
	const host = document.createElement("div");
	document.body.append(host);
	const { createRoot } = await import("react-dom/client");
	root = createRoot(host as unknown as HTMLElement);
	await act(async () => root!.render(node));
	return () => host.querySelector("span")!.getAttribute("data-inverted");
}

describe("useArtifactInversion", () => {
	it("seeds from the record, flips at once and posts the exact body", async () => {
		const state = await mount(<ChatActionsContext.Provider value={actions}><Probe messageId="m1" initial /></ChatActionsContext.Provider>);
		assert.equal(state(), "true");
		await act(async () => toggle(false));
		assert.equal(state(), "false");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "/api/chats/c1/artifact-ui");
		assert.equal(calls[0]!.init.method, "POST");
		assert.deepEqual(calls[0]!.init.headers, { "Content-Type": "application/json" });
		assert.equal(calls[0]!.init.body, JSON.stringify({ input: { messageId: "m1", inverted: false } }));
	});

	it("stays local-only without a chat page or a steer message id", async () => {
		let state = await mount(<Probe messageId="m1" />);
		assert.equal(state(), "false");
		await act(async () => toggle(true));
		assert.equal(state(), "true");
		await act(async () => root!.unmount());
		state = await mount(<ChatActionsContext.Provider value={actions}><Probe /></ChatActionsContext.Provider>);
		await act(async () => toggle(true));
		assert.equal(state(), "true");
		assert.equal(calls.length, 0);
	});

	it("swallows a failed write and keeps the local state", async () => {
		fail = true;
		const state = await mount(<ChatActionsContext.Provider value={actions}><Probe messageId="m1" /></ChatActionsContext.Provider>);
		await act(async () => toggle(true));
		assert.equal(state(), "true");
		assert.equal(calls.length, 1);
	});
});
