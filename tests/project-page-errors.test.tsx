import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, self: globalThis,
	getComputedStyle: () => ({ getPropertyValue: () => "" }), requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: (id: number) => clearTimeout(id) });
const { ProjectPage } = await import("../components/project-page.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const quietChannel = () => ({ close() {}, onOpen() {}, onEvent() {} });

const project = { id: "project_fixture", name: "Fixture", instructions: "", fileIds: [], files: [], createdAt: "2026-10-31T00:00:00.000Z", updatedAt: "2026-10-31T00:00:00.000Z" };
let root: Root;
let host: HTMLElement;
const realFetch = globalThis.fetch;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	globalThis.fetch = realFetch;
});

async function mount(chatsStatus: number) {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === "/api/chats") return new Response(JSON.stringify(chatsStatus === 200 ? { chats: [] } : { error: "boom" }), { status: chatsStatus });
		return new Response(JSON.stringify(project), { status: 200 });
	}) as typeof fetch;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root.render(<ServerEventsProvider connect={quietChannel}><ProjectPage initial={project} /></ServerEventsProvider>));
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
	return host.textContent ?? "";
}

it("shows a failed chat list instead of loading forever", async () => {
	const text = await mount(500);
	assert.match(text, /Could not load chats\./);
	assert.doesNotMatch(text, /Loading chats…/);
});

it("shows the empty state when the chat list loads", async () => {
	const text = await mount(200);
	assert.doesNotMatch(text, /Could not load chats\.|Loading chats…/);
	assert.match(text, /Start a conversation in Fixture/);
});

it("keeps a newer successful list when an older request fails later", async () => {
	let open: () => void = () => {};
	let failFirst: (response: Response) => void = () => {};
	let calls = 0;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		if (String(input) !== "/api/chats") return new Response(JSON.stringify(project), { status: 200 });
		calls++;
		if (calls === 1) return new Promise<Response>((resolve) => { failFirst = resolve; });
		return new Response(JSON.stringify({ chats: [] }), { status: 200 });
	}) as typeof fetch;
	const channel = () => ({ close() {}, onOpen(cb: () => void) { open = cb; }, onEvent() {} });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root.render(<ServerEventsProvider connect={channel}><ProjectPage initial={project} /></ServerEventsProvider>));
	await act(async () => { open(); await new Promise((resolve) => setTimeout(resolve, 0)); });
	assert.equal(calls, 2);
	await act(async () => { failFirst(new Response("{}", { status: 500 })); await new Promise((resolve) => setTimeout(resolve, 0)); });
	const text = host.textContent ?? "";
	assert.doesNotMatch(text, /Could not load chats\./);
	assert.match(text, /Start a conversation in Fixture/);
});
