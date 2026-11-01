import React, { act } from "react";
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
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	Event: dom.window.Event,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	self: globalThis,
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
// React listens for input events only when the document advertises oninput.
Object.assign(dom.document, { oninput: null });
// linkedom has no text selection; real inputs select their text on focus.
(dom.window.HTMLElement.prototype as unknown as { select: () => void }).select = () => {};
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
// react-dom reads the DOM's event support when it loads, so it loads after the setup above.
const { createRoot } = await import("react-dom/client");
const { InlineRename, renameProject } = await import("../components/inline-rename.tsx");
const { ProjectPage } = await import("../components/project-page.tsx");
const { ProjectSidebar } = await import("../components/project-sidebar.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");

let root: Root | undefined;
let host: HTMLElement | undefined;
const realFetch = globalThis.fetch;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	globalThis.fetch = realFetch;
});
async function render(node: React.ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(node));
	return host;
}
/** Type into a React-controlled input (sets the DOM value, then fires input). */
async function type(input: HTMLInputElement, value: string) {
	Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
	await act(async () => input.dispatchEvent(new dom.window.Event("input", { bubbles: true })));
}
async function key(input: HTMLInputElement, name: string) {
	// linkedom has no KeyboardEvent; React reads the type and `key`.
	const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: name });
	await act(async () => input.dispatchEvent(event));
}

it("Enter saves a new name, Escape cancels, an unchanged name just closes", async () => {
	const commits: string[] = [];
	let done = 0;
	const field = () => host!.querySelector("input") as HTMLInputElement;
	await render(<InlineRename value="Quant" ariaLabel="Name" onCommit={async (n) => void commits.push(n)} onDone={() => done++} />);
	await type(field(), "  Quant Methods  ");
	await key(field(), "Enter");
	assert.deepEqual(commits, ["Quant Methods"]);
	assert.equal(done, 1);
	await act(async () => root!.unmount());
	await render(<InlineRename value="Quant" ariaLabel="Name" onCommit={async (n) => void commits.push(n)} onDone={() => done++} />);
	await type(field(), "Other");
	await key(field(), "Escape");
	await act(async () => root!.unmount());
	await render(<InlineRename value="Quant" ariaLabel="Name" onCommit={async (n) => void commits.push(n)} onDone={() => done++} />);
	await key(field(), "Enter");
	assert.deepEqual(commits, ["Quant Methods"], "Escape and an unchanged name save nothing");
	assert.equal(done, 3);
});

it("renameProject sends the expected name and reports the server's error", async () => {
	const sent: unknown[] = [];
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		sent.push(JSON.parse(String(init.body)));
		return sent.length === 1
			? Response.json({ ok: true })
			: Response.json({ error: "This project changed on another Mac." }, { status: 409 });
	}) as typeof fetch;
	await renameProject("p1", "Quant Methods", "Quant");
	assert.deepEqual(sent[0], { name: "Quant Methods", expected: { name: "Quant" } });
	await assert.rejects(renameProject("p1", "X", "Quant"), /changed on another Mac/);
});

const project = {
	id: "project_fixture",
	name: "Fixture",
	instructions: "",
	fileIds: [],
	files: [],
	createdAt: "2026-10-31T00:00:00.000Z",
	updatedAt: "2026-10-31T00:00:00.000Z",
};
const quietChannel = () => ({ close() {}, onOpen() {}, onEvent() {} });

it("clicking the project title renames it in place", async () => {
	const puts: unknown[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/api/chats") return Response.json({ chats: [] });
		if (init?.method === "PUT") {
			puts.push(JSON.parse(String(init.body)));
			return Response.json({ ...project, name: "Quant Methods" });
		}
		return Response.json(project);
	}) as typeof fetch;
	const el = await render(
		<ServerEventsProvider connect={quietChannel}>
			<ProjectPage initial={project} />
		</ServerEventsProvider>,
	);
	const title = el.querySelector("h1 button") as HTMLButtonElement;
	await act(async () => title.click());
	const field = el.querySelector('input[aria-label="Project name"]') as HTMLInputElement;
	assert.ok(field, "the title turns into a name field");
	await type(field, "Quant Methods");
	await key(field, "Enter");
	assert.deepEqual(puts, [{ name: "Quant Methods", expected: { name: "Fixture" } }]);
	assert.equal(el.querySelector("h1")!.textContent, "Quant Methods");
});

it("right-clicking a project in the sidebar renames it in place", async () => {
	const puts: unknown[] = [];
	let refreshed = 0;
	globalThis.fetch = (async (_url: string, init?: RequestInit) => {
		puts.push(JSON.parse(String(init?.body)));
		return Response.json({ ok: true });
	}) as typeof fetch;
	const summary = { id: "p1", name: "Quant", chatCount: 0, fileCount: 0, createdAt: "", updatedAt: "" };
	const el = await render(
		<AppRouterContext.Provider value={router as never}>
			<PathnameContext.Provider value="/">
				<ProjectSidebar
					projects={[summary as never]}
					chats={[]}
					refresh={() => refreshed++}
					moveChat={() => {}}
					renderChat={() => null}
					showChats
				/>
			</PathnameContext.Provider>
		</AppRouterContext.Provider>,
	);
	const row = el.querySelector('[data-project-drop="p1"] > div') as HTMLElement;
	await act(async () => row.dispatchEvent(new dom.window.Event("contextmenu", { bubbles: true, cancelable: true })));
	const field = el.querySelector('input[aria-label="Rename Quant"]') as HTMLInputElement;
	assert.ok(field, "right-click opens the name field");
	await type(field, "Quant Methods");
	await key(field, "Enter");
	assert.deepEqual(puts, [{ name: "Quant Methods", expected: { name: "Quant" } }]);
	assert.equal(refreshed, 1);
});
