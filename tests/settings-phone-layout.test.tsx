import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

// At phone width the section nav is a row above the content, not a fixed
// 176px column beside it; from `sm` up the desktop column is unchanged.
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
	cancelAnimationFrame: clearTimeout,
});
dom.window.HTMLElement.prototype.focus = () => {};
const { createRoot } = await import("react-dom/client");
const { AppearanceProvider } = await import("../components/settings/appearance.tsx");
const { SettingsDialog } = await import("../components/settings/settings-dialog-body.tsx");

it("Settings nav: a row above the content below sm, the 176px column from sm up", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => Response.json({ settings: null })) as typeof fetch;
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => { root.render(<AppearanceProvider><SettingsDialog onClose={() => {}} initialSection="general" initialRow={null} /></AppearanceProvider>); });
		const nav = document.querySelector('[data-testid="settings-nav"]')!;
		const navClasses = nav.getAttribute("class")!.split(/\s+/);
		const frameClasses = nav.parentElement!.getAttribute("class")!.split(/\s+/);
		for (const phoneOnly of ["w-44", "flex-col", "border-r"]) assert.ok(!navClasses.includes(phoneOnly), `no unprefixed ${phoneOnly} on the nav`);
		for (const desktop of ["sm:w-44", "sm:flex-col", "sm:border-r"]) assert.ok(navClasses.includes(desktop), `nav keeps ${desktop}`);
		assert.ok(navClasses.includes("flex-wrap"), "the phone row wraps instead of overflowing");
		assert.ok(frameClasses.includes("flex-col") && frameClasses.includes("sm:flex-row"), "nav above content below sm, beside it from sm up");
	} finally {
		await act(async () => { root.unmount(); });
		host.remove();
		globalThis.fetch = realFetch;
	}
});
