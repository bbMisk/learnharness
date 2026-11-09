import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

// Keyboard focus inside Settings: it shows, and it never drops to the body
// after closing Settings, committing a field, or closing a menu with Esc.
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
	cancelAnimationFrame: clearTimeout,
});
Object.assign(dom.document, { oninput: null });
// linkedom has no focus model: track the last focus() call.
let focused: Element | null = null;
dom.window.HTMLElement.prototype.focus = function (this: Element) { focused = this; };
Object.defineProperty(dom.document, "activeElement", { get: () => focused ?? dom.document.body, configurable: true });
const { createRoot } = await import("react-dom/client");
const { AppearanceProvider } = await import("../components/settings/appearance.tsx");
const { SettingsDialog } = await import("../components/settings/settings-dialog-body.tsx");
const { CommitInput, bindSettingsMenuDismiss } = await import("../components/settings/controls.tsx");

const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
	await act(async () => { root?.unmount(); });
	host?.remove();
	root = null; host = null; focused = null;
	globalThis.fetch = realFetch;
});
async function render(node: React.ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => { root!.render(node); });
}

describe("Settings keyboard focus", () => {
	it("closing Settings hands focus back to the button that opened it", async () => {
		globalThis.fetch = (async () => Response.json({ settings: null })) as typeof fetch;
		const opener = document.createElement("button");
		document.body.append(opener);
		opener.focus();
		await render(<AppearanceProvider><SettingsDialog onClose={() => {}} initialSection="general" initialRow={null} /></AppearanceProvider>);
		// Compare identities: a failing DOM-node diff would inspect the whole document.
		assert.ok(focused !== opener, "the dialog took focus");
		await act(async () => { root!.render(<AppearanceProvider>{null}</AppearanceProvider>); });
		assert.ok(focused === opener, "focus went back to the opener");
		opener.remove();
	});

	it("Enter commits a field without dropping its focus", async () => {
		const commits: string[] = [];
		await render(<CommitInput value="20" ariaLabel="limit" testid="input" onCommit={(v) => { commits.push(v); }} />);
		const input = host!.querySelector("input")!;
		let blurs = 0;
		input.blur = () => { blurs++; };
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "30");
		await act(async () => { input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
		await act(async () => { input.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true }), { key: "Enter" })); });
		assert.deepEqual(commits, ["30"]);
		assert.equal(blurs, 0);
	});

	it("Esc on a settings menu puts focus back on its trigger", () => {
		const anchor = document.createElement("span");
		anchor.innerHTML = `<button aria-expanded="false">a</button><button aria-expanded="true">b</button>`;
		document.body.append(anchor);
		let closed = 0;
		const unbind = bindSettingsMenuDismiss({ current: anchor }, () => { closed++; });
		document.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true }), { key: "Escape" }));
		unbind();
		anchor.remove();
		assert.equal(closed, 1);
		assert.equal(focused?.textContent, "b");
	});
});
