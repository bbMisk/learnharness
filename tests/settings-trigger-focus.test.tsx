import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { assertSameNode } from "./helpers/same-node.ts";
import { afterEach, it } from "node:test";
import { parseHTML } from "linkedom";
import type { ModelCatalogEntry } from "../src/core";

// A Settings menu hands focus back to its trigger after a pick or Esc, so
// the trigger must stay the same DOM node across the menu's close.
const dom = parseHTML("<html><body><div id='root'></div></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
if (!globalThis.navigator) Object.assign(globalThis, { navigator: { userAgent: "", platform: "" } });
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
let focused: Element | null = null;
dom.window.HTMLElement.prototype.focus = function (this: Element) { focused = this; };
Object.defineProperty(dom.document, "activeElement", { get: () => (focused?.isConnected ? focused : dom.document.body), configurable: true });

const model: ModelCatalogEntry = {
	id: "fixture-vision", name: "Fixture vision", provider: "fixture", reasoning: false, input: ["text", "image"],
	supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
};
const bodies: Record<string, unknown> = {
	"/api/search": { available: false, engine: null, reason: "" },
	"/api/keys": { keys: [] },
	"/api/models": { models: [model], providers: [{ id: "fixture", envVar: "FIXTURE_KEY", label: "Fixture", keyPresent: true }], slots: { strong: null, cheap: null, vision: null } },
	"/api/settings/prompts": { prober: [], teacher: [], practice: [] },
};
globalThis.fetch = (async (url: string) => {
	assert.ok(url in bodies, `unexpected request: ${url}`);
	return Response.json(bodies[url]);
}) as typeof fetch;
const { createRoot } = await import("react-dom/client");
const { AgentSection } = await import("../components/settings/agent-section.tsx");
const { AppearanceSection } = await import("../components/settings/appearance-section.tsx");
const root = createRoot(document.getElementById("root")!);
afterEach(async () => { await act(async () => root.render(null)); focused = null; });

const element = (testid: string) => {
	const node = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
	assert.ok(node, testid);
	return node;
};
const click = async (testid: string) => { await act(async () => { element(testid).click(); await new Promise((r) => setTimeout(r, 5)); }); };

it("the first pick into an empty model slot keeps focus on its trigger", async () => {
	function Settings() {
		const [models, setModels] = React.useState({});
		return <AgentSection agent={undefined} models={models} graph={undefined} compaction={undefined} onCompactionChange={() => {}} onSectionChange={() => {}} onModelsChange={setModels} />;
	}
	await act(async () => { root.render(<Settings />); await new Promise((r) => setTimeout(r, 5)); });
	const trigger = element("slot-model-vision");
	await click("slot-model-vision");
	await click("model-option-fixture-vision");
	assert.ok(trigger.isConnected, "the trigger was not remounted");
	assertSameNode(document.activeElement, trigger);
});

it("closing the Reading font menu keeps focus on its trigger", async () => {
	await act(async () => { root.render(<AppearanceSection appearance={undefined} onSectionChange={() => {}} />); });
	const trigger = element("font-trigger");
	await click("font-trigger");
	assert.ok(document.querySelector('[data-testid="font-menu"]'));
	await act(async () => {
		document.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true }), { key: "Escape" }));
	});
	assertSameNode(document.querySelector('[data-testid="font-menu"]'), null);
	assert.ok(trigger.isConnected, "the trigger was not remounted");
	assertSameNode(document.activeElement, trigger);
});

it("the advanced model triggers wrap below 1024 px, so 640–720 px windows keep the labels readable", async () => {
	await act(async () => {
		root.render(<AgentSection agent={undefined} models={{}} graph={undefined} compaction={undefined} onCompactionChange={() => {}} onSectionChange={() => {}} onModelsChange={() => {}} />);
		await new Promise((r) => setTimeout(r, 5));
	});
	await click("models-advanced");
	const triggers = element("slot-cache-strong").parentElement!.className.split(/\s+/);
	assert.ok(triggers.includes("flex-wrap"), "the triggers wrap");
	assert.ok(!triggers.some((c) => /^(sm:|md:)?(flex-nowrap|shrink-0)$/.test(c)), "not pinned to one line below lg");
	assert.ok(triggers.includes("lg:flex-nowrap"), "one line on wide windows, as before");
});
