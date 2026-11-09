import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

// An unsaved prompt-override draft survives closing and reopening Settings,
// like the model-instruction and curation-guidance drafts.
const dom = parseHTML("<html><body><div id='root'></div></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true,
});
if (!globalThis.navigator) Object.assign(globalThis, { navigator: { userAgent: "", platform: "" } });
// React listens for input events only when the document advertises oninput.
Object.assign(dom.document, { oninput: null });
const segment = { path: "teacher/05-method.md", sourceText: "Teach.", overrideText: null, enabled: false, shared: false };
const bodies: Record<string, unknown> = {
	"/api/search": { available: false, engine: null, reason: "" },
	"/api/keys": { keys: [] },
	"/api/models": { models: [], slots: { strong: null, cheap: null, vision: null } },
	"/api/settings/prompts": { prober: [], teacher: [segment], practice: [] },
};
globalThis.fetch = (async (url: string) => {
	assert.ok(url in bodies, `unexpected request: ${url}`);
	return new Response(JSON.stringify(bodies[url]));
}) as typeof fetch;
const { createRoot } = await import("react-dom/client");
const { AgentSection } = await import("../components/settings/agent-section.tsx");

async function mount() {
	const root = createRoot(document.getElementById("root")!);
	await act(async () => {
		root.render(<AgentSection agent={{}} models={undefined} graph={undefined} compaction={undefined}
			onSectionChange={() => {}} onModelsChange={() => {}} onCompactionChange={() => {}} />);
	});
	const show = [...document.querySelectorAll<HTMLButtonElement>(`[data-testid="prompt-segment-${segment.path}"] button`)].find((b) => b.textContent === "Show text")!;
	assert.ok(show, "Show text");
	await act(async () => { show.click(); });
	return { root, override: document.querySelector<HTMLTextAreaElement>('[aria-label="Your version of the instructions"]')! };
}

it("an unsaved prompt override survives closing and reopening Settings", async () => {
	const first = await mount();
	Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(first.override, "Be brief.");
	await act(async () => { first.override.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
	await act(async () => first.root.unmount());
	const second = await mount();
	// linkedom renders no initial textarea value, so read the draft through
	// Save: it is enabled only while the draft differs from the saved text.
	const save = [...document.querySelectorAll<HTMLButtonElement>(`[data-testid="prompt-segment-${segment.path}"] button`)].find((b) => b.textContent === "Save")!;
	assert.equal(save.disabled, false, "the draft came back");
	await act(async () => second.root.unmount());
});
