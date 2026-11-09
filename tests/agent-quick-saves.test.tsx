import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import type { AgentSettings } from "../src/core";

// Flashcard-curator and model-instruction saves go through the Agent save
// queue: two quick changes on a slow server both land, and a failed save
// keeps the typed draft. Prompt overrides report an unreachable server.
const dom = parseHTML("<html><body><div id='root'></div></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true,
});
if (!globalThis.navigator) Object.assign(globalThis, { navigator: { userAgent: "", platform: "" } });
Object.assign(dom.document, { oninput: null });
const segment: { path: string; sourceText: string; overrideText: string | null; enabled: boolean; shared: boolean } = { path: "teacher/05-method.md", sourceText: "Teach.", overrideText: null, enabled: false, shared: false };
const bodies: Record<string, unknown> = {
	"/api/search": { available: false, engine: null, reason: "" },
	"/api/keys": { keys: [] },
	"/api/models": { models: [{ id: "opus", name: "Opus", provider: "anthropic" }, { id: "gpt-5", name: "GPT-5", provider: "openai" }], slots: { strong: null, cheap: null, vision: null } },
	"/api/settings/prompts": { prober: [], teacher: [segment], practice: [] },
	"/api/flashcard-agent": { running: false, phase: "Idle", preparedToday: 0, startedToday: 0, dailyLimit: 20, error: null, model: null },
};
let offline = false;
globalThis.fetch = (async (url: string) => {
	if (offline) throw new TypeError("Failed to fetch");
	assert.ok(url in bodies, `unexpected request: ${url}`);
	return Response.json(bodies[url]);
}) as typeof fetch;
const { createRoot } = await import("react-dom/client");
const { AgentSection } = await import("../components/settings/agent-section.tsx");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Mounts the section the way the dialog does: a save takes `latency` ms, then the prop follows the stored record. */
async function mount(initial: AgentSettings, latency: number, fail = false) {
	let stored = initial;
	const root = createRoot(document.getElementById("root")!);
	const render = () => root.render(<AgentSection agent={stored} models={undefined} graph={undefined} compaction={undefined}
		onSectionChange={async (next) => {
			await sleep(latency);
			if (fail) return false;
			stored = next;
			await act(async () => render());
			return true;
		}} onModelsChange={() => {}} onCompactionChange={() => {}} />);
	await act(async () => render());
	await act(async () => { await sleep(5); });
	return { root, stored: () => stored };
}
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
	const proto = element instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
	await act(async () => { element.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
}
const pickModel = (key: string) => act(() => {
	const select = document.querySelector<HTMLSelectElement>('[data-testid="model-instructions-model"]')!;
	for (const option of select.querySelectorAll("option")) option.toggleAttribute("selected", option.getAttribute("value") === key);
	select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
});
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;

it("two quick flashcard-curator changes on a slow server both land", async () => {
	const { root, stored } = await mount({ flashcards: { dailyLimit: 20 } }, 300);
	await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="automatic flashcards"]')!.click(); });
	const limit = document.querySelector<HTMLInputElement>('[data-testid="input-flashcard-agent-limit"]')!;
	await type(limit, "7");
	await act(async () => { limit.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })); });
	await act(async () => { await sleep(700); });
	assert.deepEqual(stored().flashcards, { dailyLimit: 7, enabled: false });
	assert.equal(document.querySelector('[aria-label="automatic flashcards"]')!.getAttribute("aria-checked"), "false");
	await act(async () => root.unmount());
});

it("saving instructions for two models quickly keeps both", async () => {
	const { root, stored } = await mount({}, 300);
	const text = () => document.querySelector<HTMLTextAreaElement>('[data-testid="model-instructions-text"]')!;
	pickModel("anthropic:opus");
	await type(text(), "Opus text");
	await act(async () => { button("Save instructions").click(); });
	pickModel("openai:gpt-5");
	await type(text(), "GPT text");
	await act(async () => { button("Save instructions").click(); });
	await act(async () => { await sleep(700); });
	assert.deepEqual(stored().modelInstructions, { "anthropic:opus": "Opus text", "openai:gpt-5": "GPT text" });
	await act(async () => root.unmount());
});

it("a failed guidance or instructions save keeps the draft after Settings closes", async () => {
	const first = await mount({}, 0, true);
	await type(document.querySelector<HTMLTextAreaElement>("#flashcard-curator-instructions")!, "Guidance typed");
	await act(async () => { button("Save guidance").click(); await sleep(5); });
	pickModel("anthropic:opus");
	await type(document.querySelector<HTMLTextAreaElement>('[data-testid="model-instructions-text"]')!, "Instructions typed");
	await act(async () => { button("Save instructions").click(); await sleep(5); });
	await act(async () => first.root.unmount());
	const second = await mount({}, 0);
	pickModel("anthropic:opus");
	// linkedom renders no initial textarea value: the Save buttons are enabled only while a draft differs from the saved text.
	assert.equal(button("Save guidance").disabled, false, "guidance draft kept");
	assert.equal(button("Save instructions").disabled, false, "instructions draft kept");
	// A save that lands drops both drafts.
	await act(async () => { button("Save guidance").click(); await sleep(5); });
	await act(async () => { button("Save instructions").click(); await sleep(5); });
	assert.deepEqual(second.stored(), { flashcards: { instructions: "Guidance typed" }, modelInstructions: { "anthropic:opus": "Instructions typed" } });
	await act(async () => second.root.unmount());
	const third = await mount(second.stored(), 0);
	pickModel("anthropic:opus");
	assert.equal(button("Save guidance").disabled, true);
	assert.equal(button("Save instructions").disabled, true);
	await act(async () => third.root.unmount());
});

it("an offline prompt-override Save or Delete says it failed", async () => {
	segment.overrideText = "Saved before.";
	const { root } = await mount({}, 0);
	const row = () => [...document.querySelectorAll<HTMLButtonElement>(`[data-testid="prompt-segment-${segment.path}"] button`)];
	await act(async () => { row().find((b) => b.textContent === "Show text")!.click(); });
	await type(document.querySelector<HTMLTextAreaElement>('[aria-label="Your version of the instructions"]')!, "Be brief.");
	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onRejection);
	offline = true;
	try {
		await act(async () => { row().find((b) => b.textContent === "Save")!.click(); await sleep(5); });
		assert.equal(document.querySelector('[data-testid="segment-status"]')?.textContent, "Save failed. Try again.");
		await act(async () => { row().find((b) => b.textContent === "Delete")!.click(); await sleep(5); });
		assert.equal(document.querySelector('[data-testid="segment-status"]')?.textContent, "Delete failed. Try again.");
		await act(async () => { await sleep(5); });
		assert.deepEqual(rejections, []);
	} finally {
		offline = false;
		process.off("unhandledRejection", onRejection);
		segment.overrideText = null;
	}
	await act(async () => root.unmount());
});
