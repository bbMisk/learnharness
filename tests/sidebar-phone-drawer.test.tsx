/**
 * The phone drawer: Esc closes it, and its opens and closes never become
 * the desktop sidebar preference.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const storage = new Map<string, string>();
let phone = true;
const mediaListeners = new Set<() => void>();
Object.assign(dom.window, { innerWidth: 390, innerHeight: 844 });
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Node: dom.window.Node, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
	},
});
Object.assign(dom.window, {
	localStorage: (globalThis as { localStorage: unknown }).localStorage,
	matchMedia: () => ({
		get matches() { return phone; },
		addEventListener: (_: string, cb: () => void) => mediaListeners.add(cb),
		removeEventListener: (_: string, cb: () => void) => mediaListeners.delete(cb),
	}),
});

const { createRoot } = await import("react-dom/client");
const { SidebarProvider, useSidebar } = await import("../components/sidebar.tsx");

let sidebar!: ReturnType<typeof useSidebar>;
function Probe() {
	sidebar = useSidebar();
	return null;
}
const esc = () => Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" });

it("Esc closes the open phone drawer, and claims the key", async () => {
	phone = true;
	storage.set("lh:sidebar-open", "1");
	const root = createRoot(document.createElement("div"));
	await act(async () => root.render(<SidebarProvider><Probe /></SidebarProvider>));
	await act(async () => sidebar.toggle());
	assert.equal(sidebar.open, true);
	const event = esc();
	await act(async () => document.body.dispatchEvent(event));
	assert.equal(sidebar.open, false);
	assert.equal(event.defaultPrevented, true);
	await act(async () => root.unmount());
});

it("phone opens and closes leave the desktop preference, which returns on widening", async () => {
	phone = true;
	storage.set("lh:sidebar-open", "1");
	const root = createRoot(document.createElement("div"));
	await act(async () => root.render(<SidebarProvider><Probe /></SidebarProvider>));
	await act(async () => sidebar.toggle());
	await act(async () => sidebar.toggle());
	assert.equal(sidebar.open, false);
	assert.equal(storage.get("lh:sidebar-open"), "1", "the drawer's close is not the preference");
	phone = false;
	await act(async () => { for (const cb of mediaListeners) cb(); });
	assert.equal(sidebar.open, true, "widening restores the stored open sidebar");
	await act(async () => root.unmount());
});
