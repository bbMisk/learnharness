import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { assertSameNode } from "./helpers/same-node.ts";
import { afterEach, test } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
// linkedom has no input `type` property; React only tracks typing into text-like inputs.
Object.defineProperty(dom.window.HTMLInputElement.prototype, "type", { configurable: true, get(this: Element) { return this.getAttribute("type") ?? "text"; } });
// React listens for input events only when the document advertises oninput,
// and it checks once at load, so react-dom loads after the DOM.
Object.assign(dom.document, { oninput: null });
const { createRoot } = await import("react-dom/client");
const { KeysSection, CustomEndpointSetup } = await import("../components/settings/keys-section.tsx");
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLElement | undefined;
async function mount(setup = false) {
	globalThis.fetch = async (input, init) => {
		assert.equal(init?.method ?? "GET", "GET", "polish interactions must not save credentials/settings");
		if (String(input).startsWith("/api/custom-provider")) return Response.json({ baseUrl: "http://fixture.invalid/v1", authMode: "keyless", keySource: "none", keyPresent: false, keyReuseRequired: false, models: [{ id: "fixture-model" }], overrides: {}, manualModels: [] }, { headers: { etag: '"fixture"' } });
		return Response.json({ keys: [], providers: [] });
	};
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => root!.render(setup ? <CustomEndpointSetup onSaved={() => assert.fail("unexpected save")} /> : <KeysSection />));
	if (!setup) await click("custom-endpoint-row-btn");
}
function element(id: string) { const node = document.querySelector<HTMLElement>(`[data-testid="${id}"]`); assert.ok(node, id); return node; }
async function click(id: string) { await act(async () => element(id).dispatchEvent(new dom.window.Event("click", { bubbles: true }))); }
async function selectMode(value: string) {
	const select = element("custom-auth-mode");
	Object.defineProperty(select, "value", { value, configurable: true });
	await act(async () => select.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
}
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; globalThis.fetch = originalFetch; });
for (const setup of [false, true]) {
	test(`${setup ? "Setup" : "Settings"} hides key input in Keyless and reveals it only in API key mode`, async () => {
		await mount(setup);
		assertSameNode(document.querySelector('[data-testid="custom-key-input"]'), null);
		await selectMode("apiKey"); assert.equal(element("custom-key-input").getAttribute("type"), "password");
		await selectMode("keyless"); assertSameNode(document.querySelector('[data-testid="custom-key-input"]'), null);
		assert.ok(element("custom-save"));
	});
}
test("model controls use approved effort labels, right-align Save limits, and group help below", async () => {
	await mount();
	const select = element("custom-pin-reasoning-fixture-model");
	assert.equal(select.getAttribute("aria-label"), "fixture-model reasoning effort support");
	assert.deepEqual(Array.from(select.children).map(option => option.textContent), ["Reasoning effort: Use reported", "Reasoning effort: Supported", "Reasoning effort: Not supported"]);
	assert.deepEqual(Array.from(select.children).map(option => option.getAttribute("value")), ["", "on", "off"], "capability values unchanged");
	const save = element("custom-pins-save"); assert.ok(save.classList.contains("ml-auto")); assertSameNode(save.parentElement!.lastElementChild, save);
	const help = element("custom-help"); assertSameNode(element("custom-budget-help").parentElement, help); assertSameNode(element("custom-reasoning-help").parentElement, help);
	const children = Array.from(element("custom-endpoint-editor").children); assert.ok(children.indexOf(help) > children.indexOf(element("custom-pins")));
	assert.match(help.textContent ?? "", /do not resize backend context/); assert.match(help.textContent ?? "", /Off may not disable/);
});
test("clearing the typed API key keeps API key authentication", async () => {
	await mount();
	await selectMode("apiKey");
	const input = element("custom-key-input");
	for (const value of ["x", ""]) {
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
		await act(async () => input.dispatchEvent(new dom.window.Event("input", { bubbles: true })));
	}
	assert.ok(element("custom-key-input"), "the key field stays: auth did not flip to Keyless");
});
test("Disconnect arms on the first click and only the second click disconnects", async () => {
	await mount();
	await click("custom-delete"); // the GET-only fetch stub fails on a DELETE
	assert.equal(element("custom-delete").textContent, "Confirm disconnect");
});
