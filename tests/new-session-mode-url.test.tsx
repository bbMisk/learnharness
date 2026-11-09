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
globalThis.fetch = (async (url: RequestInfo | URL) => String(url).includes("/api/settings") ? Response.json({ settings: { general: {} } }) : new Response("{}", { status: 404 })) as typeof fetch;
const replaced: string[] = [];
Object.assign(dom.window, { history: { replaceState: (_: unknown, __: string, href: string) => void replaced.push(href) } });
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
const { createRoot } = await import("react-dom/client");
const { NewSession } = await import("../components/new-session.tsx");

/** The draft's in-page mode switch writes the URL, so the sidebar's
 *  "+ Teaching" (a push to /chat/new) is always a change of ?mode=. */
it("the draft's mode switch writes ?mode= to the URL", async () => {
	replaced.length = 0;
	const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(
			<AppRouterContext.Provider value={router as never}>
				<NewSession initialConfigured projectId="p1" />
			</AppRouterContext.Provider>,
		));
		const chip = (m: string) => host.querySelector(`[data-testid="draft-mode-${m}"]`) as HTMLButtonElement;
		await act(async () => chip("practice").click());
		await act(async () => chip("cram").click());
		await act(async () => chip("teach").click());
		assert.deepEqual(replaced, ["/chat/new?mode=practice&project=p1", "/chat/new?mode=cram&project=p1", "/chat/new?project=p1"]);
	} finally {
		await act(async () => root.unmount());
	}
});

/** The URL is the mode: "+ Teaching" right after a chip click lands in
 *  Teach even when the chip's URL write and the push race. */
it("the mode follows ?mode= after a chip click, so a push to /chat/new resets it", async () => {
	const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const at = (query: string) => root.render(
		<AppRouterContext.Provider value={router as never}>
			<SearchParamsContext.Provider value={new URLSearchParams(query) as never}>
				<NewSession initialConfigured mode="teach" />
			</SearchParamsContext.Provider>
		</AppRouterContext.Provider>,
	);
	const chip = (m: string) => host.querySelector(`[data-testid="draft-mode-${m}"]`) as HTMLButtonElement;
	const pressed = () => ["teach", "practice", "cram"].find((m) => chip(m).getAttribute("aria-pressed") === "true");
	try {
		await act(async () => at(""));
		await act(async () => chip("cram").click());
		assert.equal(pressed(), "cram");
		await act(async () => at("mode=cram")); // the chip's own URL write
		await act(async () => at("")); // the sidebar's push to /chat/new
		assert.equal(pressed(), "teach");
	} finally {
		await act(async () => root.unmount());
	}
});
