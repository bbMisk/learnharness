import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";

/** Typed but unsaved project instructions survive leaving the page. */
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	self: globalThis,
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
const storage = new Map<string, string>();
Object.defineProperty(dom.window, "localStorage", { configurable: true, value: {
	getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); },
	removeItem: (k: string) => { storage.delete(k); }, key: (i: number) => [...storage.keys()][i] ?? null, get length() { return storage.size; },
} });
// React listens for input events only when the document advertises oninput.
Object.assign(dom.document, { oninput: null });
const { createRoot } = await import("react-dom/client");
const { ProjectPage } = await import("../components/project-page.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
const quietChannel = () => ({ close() {}, onOpen() {}, onEvent() {} });

let project = {
	id: "project_fixture",
	name: "Fixture",
	instructions: "",
	fileIds: [],
	files: [],
	createdAt: "2026-10-31T00:00:00.000Z",
	updatedAt: "2026-10-31T00:00:00.000Z",
};
let root: Root | undefined;
let host: HTMLElement | undefined;
const realFetch = globalThis.fetch;
afterEach(async () => {
	await unmount();
	globalThis.fetch = realFetch;
	storage.clear();
});
async function unmount() {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
async function mount() {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/api/chats") return Response.json({ chats: [] });
		if (init?.method === "PUT") {
			const body = JSON.parse(String(init.body));
			project = { ...project, instructions: body.instructions, updatedAt: "2026-11-01T00:00:00.000Z" };
		}
		return Response.json(project);
	}) as typeof fetch;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<AppRouterContext.Provider value={router as never}>
				<ServerEventsProvider connect={quietChannel}>
					<ProjectPage initial={project} />
				</ServerEventsProvider>
			</AppRouterContext.Provider>,
		),
	);
	await settle();
}
const textarea = () => {
	const node = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Project instructions"]');
	assert.ok(node);
	return node;
};
async function type(value: string) {
	const node = textarea();
	// The prototype setter: React's value tracker hides a plain assignment.
	Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(node, value);
	await act(async () => node.dispatchEvent(new dom.window.Event("input", { bubbles: true })));
}
const waitForDraftWrite = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });

it("restores unsaved instructions after leaving the page, and a save clears them", async () => {
	await mount();
	await type("Use Socratic questions. 🎯");
	await waitForDraftWrite();
	await unmount();
	await mount();
	assert.equal(textarea().value, "Use Socratic questions. 🎯");
	const saveButton = [...document.querySelectorAll("button")].find((b) => b.textContent === "Save changes");
	assert.ok(saveButton);
	assert.equal(saveButton.hasAttribute("disabled"), false, "the restored draft is unsaved, so Save is live");
	await act(async () => textarea().closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
	await settle();
	await waitForDraftWrite();
	assert.equal(project.instructions, "Use Socratic questions. 🎯");
	assert.equal(storage.size, 0, "a successful save drops the draft");
	await unmount();
	await mount();
	assert.equal(textarea().value, "Use Socratic questions. 🎯");
});

it("typing back to the saved text leaves no draft", async () => {
	await mount();
	await type("x");
	await type(project.instructions);
	await waitForDraftWrite();
	assert.equal(storage.size, 0);
});
