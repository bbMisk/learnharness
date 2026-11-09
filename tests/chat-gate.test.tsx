/** QA #2 / #25: an open chat whose record is gone (deleted in another tab,
 *  or restored by browser Back after a delete) shows the in-app not-found
 *  page, and a rename made elsewhere reaches the open view. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	self: globalThis,
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
const { ChatGate } = await import("../components/chat-gate.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const NotFound = (await import("../app/not-found.tsx")).default;

let root: Root;
let host: HTMLElement;
const realFetch = globalThis.fetch;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	globalThis.fetch = realFetch;
});

async function mount(respond: () => Response) {
	const urls: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		urls.push(String(input));
		return respond();
	}) as typeof fetch;
	let fire: (name: string, data: string) => void = () => {};
	const channel = () => ({
		close() {},
		onOpen() {},
		onEvent(name: string, cb: (data: string) => void) {
			const previous = fire;
			fire = (n, d) => (n === name ? cb(d) : previous(n, d));
		},
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<ServerEventsProvider connect={channel}>
				<ChatGate chatId="chat_x" title="Old title">
					<p>live chat</p>
				</ChatGate>
			</ServerEventsProvider>,
		),
	);
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
	return { urls, event: async (name: string) => act(async () => { fire(name, "{}"); await new Promise((r) => setTimeout(r, 0)); }) };
}

it("a chat whose record 404s on mount (browser Back after delete) shows the not-found page", async () => {
	const { urls } = await mount(() => new Response("{}", { status: 404 }));
	assert.deepEqual(urls, ["/api/chats/chat_x?only=title"]);
	assert.doesNotMatch(host.textContent ?? "", /live chat/);
	assert.match(host.textContent ?? "", /Go home/);
	assert.match(host.textContent ?? "", /This chat was deleted\./);
});

it("a delete in another tab (chats-changed, then 404) swaps the open chat out", async () => {
	let status = 200;
	const { event } = await mount(() => new Response(JSON.stringify({ title: "Old title" }), { status }));
	assert.match(host.textContent ?? "", /live chat/);
	status = 404;
	await event("chats-changed");
	assert.match(host.textContent ?? "", /Go home/);
});

it("a chat found gone stops re-reading on later events", async () => {
	const { urls, event } = await mount(() => new Response("{}", { status: 404 }));
	await event("chats-changed");
	await event("chats-changed");
	assert.deepEqual(urls, ["/api/chats/chat_x?only=title"]);
});

it("a rename in another tab goes out as lh:chat-renamed, once", async () => {
	let title = "Old title";
	const renamed: unknown[] = [];
	const listen = (e: Event) => renamed.push((e as CustomEvent).detail);
	window.addEventListener("lh:chat-renamed", listen);
	try {
		const { event } = await mount(() => new Response(JSON.stringify({ title }), { status: 200 }));
		assert.deepEqual(renamed, [], "the title it opened with is not news");
		title = "Renamed in tab B";
		await event("chats-changed");
		await event("chats-changed");
		assert.deepEqual(renamed, [{ id: "chat_x", title: "Renamed in tab B" }]);
		assert.match(host.textContent ?? "", /live chat/);
	} finally {
		window.removeEventListener("lh:chat-renamed", listen);
	}
});

it("an archived open chat says so; the window title follows the chat's", async () => {
	let body = { title: "Old title", archived: false };
	document.title = "Learning Harness";
	const { event } = await mount(() => new Response(JSON.stringify(body), { status: 200 }));
	assert.equal(document.title, "Old title");
	assert.equal(host.querySelector('[data-testid="chat-archived"]'), null);
	body = { title: "New title", archived: true };
	await event("chats-changed");
	assert.match(host.textContent ?? "", /This chat is archived\./);
	assert.equal(document.title, "New title");
	body = { title: "New title", archived: false };
	await event("chats-changed");
	assert.equal(host.querySelector('[data-testid="chat-archived"]'), null, "restored elsewhere: the note goes");
	await act(async () => root.unmount());
	assert.equal(document.title, "Learning Harness", "leaving the chat restores the app title");
});

it("the app's not-found page links home", () => {
	const html = renderToStaticMarkup(<NotFound />);
	assert.match(html, /href="\/"/);
	assert.match(html, /Go home/);
});
