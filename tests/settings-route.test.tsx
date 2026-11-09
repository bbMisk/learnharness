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
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: (id: number) => clearTimeout(id),
});
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { createRoot } = await import("react-dom/client");
const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { default: SettingsPage } = await import("../app/settings/page.tsx");

it("/settings opens the Settings dialog and leaves the URL for the draft view", async () => {
	const replaced: string[] = [];
	const router = { push() {}, replace(href: string) { replaced.push(href); }, refresh() {}, back() {}, forward() {}, prefetch() {} };
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(
			<AppRouterContext.Provider value={router as never}>
				<SettingsDialogProvider><SettingsPage /></SettingsDialogProvider>
			</AppRouterContext.Provider>,
		));
		for (let i = 0; i < 50 && !document.querySelector('[data-testid="settings-dialog"]'); i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
		assert.ok(document.querySelector('[data-testid="settings-dialog"]'), "the dialog is open");
		assert.deepEqual(replaced, ["/chat/new"]);
	} finally {
		await act(async () => root.unmount());
	}
});
