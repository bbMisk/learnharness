/**
 * Page load: the restored sidebar width is laid out before its slide
 * transition turns on (a load-time slide resized the graph canvas
 * mid-mount and shifted its saved camera). Phones start closed.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const storage = new Map<string, string>([["lh:sidebar-open", "1"]]);
let phone = false;
Object.assign(dom.window, { innerWidth: 1400, innerHeight: 900 });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
	},
});
Object.assign(dom.window, {
	localStorage: (globalThis as { localStorage: unknown }).localStorage,
	matchMedia: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }),
});

const { createRoot } = await import("react-dom/client");
const { SidebarProvider, SidebarToggle } = await import("../components/sidebar.tsx");

const TRANSITIONS = "[&_.sidebar-motion]:transition-[width,margin,opacity]";

async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	// Snapshot the DOM whenever layout is forced.
	const layouts: { sidebarOpen: boolean; transitions: boolean }[] = [];
	Object.defineProperty(document.body, "offsetWidth", {
		configurable: true,
		get() {
			const wrapper = host.firstElementChild!;
			layouts.push({
				// The toggle slot collapses (w-0) while the sidebar is open.
				sidebarOpen: wrapper.querySelector(".sidebar-motion")!.className.includes("w-0"),
				transitions: wrapper.className.includes(TRANSITIONS),
			});
			return 0;
		},
	});
	await act(async () => root.render(<SidebarProvider><SidebarToggle /></SidebarProvider>));
	const wrapper = host.firstElementChild!;
	const result = {
		layouts,
		transitions: wrapper.className.includes(TRANSITIONS),
		open: wrapper.querySelector(".sidebar-motion")!.className.includes("w-0"),
	};
	await act(async () => root.unmount());
	host.remove();
	return result;
}

it("lays out the stored open width before turning transitions on", async () => {
	phone = false;
	const r = await mount();
	assert.equal(r.open, true);
	assert.equal(r.transitions, true, "transitions on after mount");
	assert.deepEqual(r.layouts, [{ sidebarOpen: true, transitions: false }], "open width laid out with transitions off");
});

it("starts closed on a phone, whatever was stored", async () => {
	phone = true;
	const r = await mount();
	assert.equal(r.open, false);
});
