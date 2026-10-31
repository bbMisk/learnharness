import React, { act, useRef } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
let focused: Element | null = null;
Object.defineProperty(dom.document, "activeElement", { get: () => focused ?? dom.document.body });
dom.window.HTMLElement.prototype.focus = function (this: HTMLElement) {
	focused = this;
	this.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
};
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
});
let keep = true;
globalThis.fetch = (async () => Response.json({ settings: { general: { keepThinkingFocus: keep } } })) as typeof fetch;
const { useThinkingFocus } = await import("../components/thinking-focus.ts");

type Hook = typeof useThinkingFocus;
function Dock({ hook = useThinkingFocus }: { hook?: Hook }) {
	const root = useRef<HTMLDivElement>(null);
	const thinking = useRef<HTMLDivElement>(null);
	hook(root, thinking, true);
	return (
		<div ref={root} data-testid="question-dock">
			<button data-kbdrow="0" data-testid="option">
				90°
			</button>
			<div data-kbdrow="1" data-testid="other-row">
				<div role="textbox" contentEditable="true" suppressContentEditableWarning data-testid="other-input" />
			</div>
			<div ref={thinking} role="textbox" contentEditable="true" suppressContentEditableWarning data-testid="thinking" />
		</div>
	);
}

let root: Root | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.innerHTML = "";
	focused = null;
});
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const tick = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
const pointer = async (el: HTMLElement) => {
	await act(async () => {
		el.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
		el.focus();
		window.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
	});
	await tick();
};

async function arriveFromComposer(hook?: Hook) {
	const composer = document.createElement("div");
	composer.setAttribute("data-testid", "composer");
	composer.innerHTML = '<div contenteditable="true" data-testid="composer-field"></div>';
	document.body.append(composer);
	q("composer-field").focus();
	composer.remove(); // the dock replaces the composer: focus is gone
	focused = null;
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<Dock hook={hook} />));
	// Browsers match attribute names case-insensitively; linkedom keeps React's camelCase.
	for (const el of document.querySelectorAll("*"))
		if (el.getAttribute("contentEditable") === "true") el.setAttribute("contenteditable", "true");
	await tick();
}

it("a question that arrives while typing in the composer takes the cursor into Your thinking", async () => {
	keep = true;
	await arriveFromComposer();
	assert.ok(document.activeElement === q("thinking"));
});

it("clicking an option hands the cursor back to Your thinking", async () => {
	keep = true;
	await arriveFromComposer();
	await pointer(q("option"));
	assert.ok(document.activeElement === q("thinking"));
});

it("the Other row keeps its own text field", async () => {
	keep = true;
	await arriveFromComposer();
	await pointer(q("other-input"));
	assert.ok(document.activeElement === q("other-input"));
});

it("with the setting off, nothing moves the cursor", async () => {
	keep = false;
	const fresh = (await import(`../components/thinking-focus.ts?off=${1}`)) as typeof import("../components/thinking-focus.ts");
	await arriveFromComposer(fresh.useThinkingFocus);
	await tick();
	await pointer(q("option"));
	assert.ok(document.activeElement !== q("thinking"));
});
