import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, self: globalThis,
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: (id: number) => clearTimeout(id),
});
const storage = new Map<string, string>();
const store = {
	getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); },
	removeItem: (k: string) => { storage.delete(k); }, key: (i: number) => [...storage.keys()][i] ?? null, get length() { return storage.size; },
};
Object.defineProperty(dom.window, "localStorage", { configurable: true, value: store });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: store });
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) =>
	String(url) === "/api/chats" && init?.method === "POST" ? Response.json({ id: "c_new" }) : new Response("", { status: 404 })) as typeof fetch;
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { createRoot } = await import("react-dom/client");
const { NewSession } = await import("../components/new-session.tsx");

/** The new-session composer autosaves its unsent text like a chat's
 *  composer: restored on mount, cleared once the session is created. */
it("the /chat/new draft survives a remount and is cleared on send", async () => {
	storage.clear();
	storage.set("lh:draft:new:chat:p1", JSON.stringify("saved opening"));
	const pushed: string[] = [];
	const router = { push: (href: string) => void pushed.push(href), replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const box = () => host.querySelector('[role="textbox"]') as HTMLElement;
	try {
		await act(async () => root.render(
			<AppRouterContext.Provider value={router as never}>
				<NewSession initialConfigured projectId="p1" />
			</AppRouterContext.Provider>,
		));
		assert.equal(box().textContent, "saved opening");
		await act(async () => {
			box().textContent = "typed opening";
			box().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 350));
		});
		assert.equal(storage.get("lh:draft:new:chat:p1"), JSON.stringify("typed opening"));
		await act(async () => {
			host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
			await new Promise((r) => setTimeout(r, 20));
		});
		assert.deepEqual(pushed, ["/chat/c_new"]);
		assert.equal(storage.has("lh:draft:new:chat:p1"), false);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

it("the home composer's draft survives a remount and is cleared on send", async () => {
	const { Home } = await import("../components/home.tsx");
	storage.clear();
	storage.set("lh:draft:new:home", JSON.stringify("saved topic"));
	const pushed: string[] = [];
	const router = { push: (href: string) => void pushed.push(href), replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const box = () => host.querySelector('[role="textbox"]') as HTMLElement;
	try {
		await act(async () => root.render(
			<AppRouterContext.Provider value={router as never}>
				<Home initialConfigured rendering={false} />
			</AppRouterContext.Provider>,
		));
		assert.equal(box().textContent, "saved topic");
		await act(async () => {
			box().textContent = "typed topic";
			box().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 350));
		});
		assert.equal(storage.get("lh:draft:new:home"), JSON.stringify("typed topic"));
		await act(async () => {
			host.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
			await new Promise((r) => setTimeout(r, 20));
		});
		assert.deepEqual(pushed, ["/chat/c_new"]);
		assert.equal(storage.has("lh:draft:new:home"), false);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});
