import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
});
// React listens for input events only when the document advertises oninput.
Object.assign(dom.document, { oninput: null });
const { createRoot } = await import("react-dom/client");
const { FlashcardAgentSection } = await import("../components/settings/flashcard-agent-section.tsx");

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = null; host = null;
	globalThis.fetch = realFetch;
});
async function render(onChange: (next: unknown) => void = () => {}) {
	globalThis.fetch = (async () => Response.json({ running: false, phase: "Idle", preparedToday: 0, startedToday: 0, dailyLimit: 20, error: null, model: null })) as typeof fetch;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<FlashcardAgentSection agent={{ flashcards: { dailyLimit: 20 } }} onChange={onChange} />));
}
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
	const proto = element instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
	await act(async () => { element.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
}

it("unsaved curation guidance survives closing and reopening Settings", async () => {
	await render();
	await type(document.querySelector<HTMLTextAreaElement>("#flashcard-curator-instructions")!, "Prioritize definitions");
	await act(async () => root!.unmount());
	root = createRoot(host!);
	await act(async () => root!.render(<FlashcardAgentSection agent={{ flashcards: { dailyLimit: 20 } }} onChange={() => {}} />));
	assert.equal(document.querySelector<HTMLTextAreaElement>("#flashcard-curator-instructions")!.value, "Prioritize definitions");
});

it("an out-of-range daily limit says why it was refused", async () => {
	const changes: unknown[] = [];
	await render((next) => changes.push(next));
	const input = document.querySelector<HTMLInputElement>('[data-testid="input-flashcard-agent-limit"]')!;
	await type(input, "1000");
	await act(async () => { input.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })); });
	assert.deepEqual(changes, []);
	assert.match(document.querySelector('[data-testid="input-flashcard-agent-limit-error"]')?.textContent ?? "", /1 to 100/);
});
