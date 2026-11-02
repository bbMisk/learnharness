/**
 * The sidebar's list fetches (components/chat-list-refresh.ts), counted
 * through the hook the sidebar mounts: one settled turn = one GET
 * /api/chats (the same-window instant and the server's turn-settled no
 * longer both fetch), projects only when they may have changed, reconnect
 * resync immediate — and a server event the local fetch could not have
 * seen still lands.
 */
import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	self: globalThis,
});
const { createRoot } = await import("react-dom/client");
const { useChatListRefresh, EVENT_REFRESH_MS } = await import("../components/chat-list-refresh.ts");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
type ChatListItem = import("../src/core/index.ts").ChatListItem;
type NotifySource = import("../components/server-events.tsx").NotifySource;

const realFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	globalThis.fetch = realFetch;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Let every debounce and in-flight fetch run out. */
const settle = () => act(async () => { await sleep(EVENT_REFRESH_MS + 150); });

/** A fake server: the list reflects `busy` at the moment the request is
 *  handled; each response takes `latencyMs`. Counts both endpoints. */
function fakeServer(latencyMs = 0) {
	const busy = new Set<string>();
	const counts = { list: 0, projects: 0 };
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === "/api/projects") {
			counts.projects++;
			return Response.json({ projects: [{ id: "project_a", name: "A" }] });
		}
		assert.equal(url, "/api/chats");
		counts.list++;
		const chats = ["chat_x", "chat_y"].map((id) => ({ id, title: id, updatedAt: "2026-11-01T00:00:00Z", busy: busy.has(id) }));
		await sleep(latencyMs);
		return Response.json({ chats });
	}) as typeof fetch;
	return { busy, counts };
}

/** Mount the hook under a scripted events channel. */
async function mount() {
	let open = () => {};
	const handlers = new Map<string, (raw: string) => void>();
	const source: NotifySource = {
		close() {},
		onOpen: (cb) => { open = cb; },
		onEvent: (name, cb) => { handlers.set(name, cb); },
	};
	const state: { chats: ChatListItem[] | null } = { chats: null };
	function Harness() {
		const [chats, setChats] = useState<ChatListItem[] | null>(null);
		const [, setProjects] = useState<unknown[]>([]);
		state.chats = chats;
		useChatListRefresh({ chats, setChats, setProjects });
		return null;
	}
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<ServerEventsProvider connect={() => source}><Harness /></ServerEventsProvider>));
	return {
		state,
		server: (name: string, payload: object) => act(async () => handlers.get(name)!(JSON.stringify(payload))),
		local: (id: string, running: boolean) =>
			act(async () => { window.dispatchEvent(new CustomEvent("lh:turn-state", { detail: { id, running } })); }),
		reconnect: () => act(async () => open()),
	};
}

it("a same-window settle plus the server's turn-settled: one list fetch, no projects (server event first)", async () => {
	const { counts } = fakeServer();
	const view = await mount();
	await view.server("turn-settled", { chatId: "chat_x" });
	await view.local("chat_x", false);
	await settle();
	assert.deepEqual(counts, { list: 1, projects: 0 });
});

it("a same-window settle plus the server's turn-settled: one list fetch, no projects (event lands mid-fetch)", async () => {
	const { counts } = fakeServer(40);
	const view = await mount();
	await view.local("chat_x", false);
	await view.server("turn-settled", { chatId: "chat_x" }); // arrives while the local fetch is in flight
	await settle();
	assert.deepEqual(counts, { list: 1, projects: 0 });
	assert.equal(view.state.chats?.find((c) => c.id === "chat_x")?.busy, false);
});

it("a server settle the local fetch could not have seen still lands", async () => {
	const { busy, counts } = fakeServer(40);
	const view = await mount();
	// The local view stopped first (an abort, a refused send): the server's
	// turn is still running when the local fetch is handled.
	busy.add("chat_x");
	await view.local("chat_x", false);
	await settle();
	assert.equal(view.state.chats?.find((c) => c.id === "chat_x")?.busy, true);
	busy.delete("chat_x");
	await view.server("turn-settled", { chatId: "chat_x" });
	await settle();
	assert.deepEqual(counts, { list: 2, projects: 0 });
	assert.equal(view.state.chats?.find((c) => c.id === "chat_x")?.busy, false, "the list ends current");
});

it("a new turn's settle is never mistaken for the covered one", async () => {
	const { busy, counts } = fakeServer();
	const view = await mount();
	await view.local("chat_x", false);
	await settle(); // snapshot: chat_x idle
	busy.add("chat_x");
	await view.server("turn-started", { chatId: "chat_x" });
	await settle(); // fetch: chat_x busy
	busy.delete("chat_x");
	await view.server("turn-settled", { chatId: "chat_x" });
	await settle();
	assert.deepEqual(counts, { list: 3, projects: 0 });
	assert.equal(view.state.chats?.find((c) => c.id === "chat_x")?.busy, false);
});

it("chats-changed fetches the list and projects once, after the debounce", async () => {
	const { counts } = fakeServer();
	const view = await mount();
	await view.server("chats-changed", {});
	await view.server("chats-changed", {});
	assert.deepEqual(counts, { list: 0, projects: 0 }, "debounced");
	await settle();
	assert.deepEqual(counts, { list: 1, projects: 1 });
});

it("turn and compaction events never fetch projects", async () => {
	const { counts } = fakeServer();
	const view = await mount();
	await view.server("turn-started", { chatId: "chat_y" });
	await view.server("compaction-changed", { chatId: "chat_y", running: true });
	await settle();
	assert.deepEqual(counts, { list: 1, projects: 0 });
});

it("a reconnect resyncs immediately, list and projects, and absorbs pending events", async () => {
	const { counts } = fakeServer();
	const view = await mount();
	await view.server("turn-settled", { chatId: "chat_x" });
	await view.reconnect();
	assert.equal(counts.list, 1, "the list request goes out at once, before any debounce");
	await settle();
	assert.deepEqual(counts, { list: 1, projects: 1 }, "projects follow the list; the pending event needs nothing more");
});

it("a stalled projects request times out instead of holding the queue; the list still lands", async () => {
	const { createChatListRefresher } = await import("../components/chat-list-refresh.ts");
	let listFetches = 0;
	const lists: ChatListItem[][] = [];
	const refresher = createChatListRefresher({
		fetchList: async () => { listFetches++; return []; },
		fetchProjects: () => new Promise(() => {}),
		onList: (list) => lists.push(list),
		onProjects: () => assert.fail("a stalled request delivers nothing"),
		onError: () => {},
		timeoutMs: 20,
	});
	await refresher.refresh();
	assert.equal(lists.length, 1, "the chat list was delivered before the projects stall");
	await refresher.refresh();
	assert.equal(listFetches, 2, "the next refresh was not blocked");
	refresher.dispose();
});
