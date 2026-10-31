import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useSideTutor } from "../components/side-tutor.tsx";
import { kbdEventForAction } from "../src/core/keyboard.ts";

// Assertions compare DOM nodes by identity: inspecting a linkedom node in a
// failure message never finishes.
const dom = parseHTML("<html><body></body></html>");
// linkedom has no focus model; track the focused element for the hook.
let active: Element | null = null;
Object.defineProperty(dom.document, "activeElement", { get: () => active, configurable: true });
dom.window.HTMLElement.prototype.focus = function (this: Element) {
	active = this;
};
Object.assign(dom.window, { getSelection: () => ({ toString: () => "selected lesson text" }) });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
});

let root: Root;
let host: HTMLElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	active = null;
});

function Harness() {
	const { sideTutor, toggleSideTutor } = useSideTutor();
	return (
		<div>
			<input data-testid="lesson" />
			<button type="button" aria-expanded={sideTutor !== null} onClick={toggleSideTutor}>
				Side tutor
			</button>
			{sideTutor && (
				<div data-testid="side-tutor" data-selected={sideTutor.selectedText}>
					<textarea />
				</div>
			)}
		</div>
	);
}
async function mount() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root.render(<Harness />));
}
const tutor = () => document.querySelector('[data-testid="side-tutor"]');
const fire = (type: string, target: EventTarget = window) =>
	act(async () => void target.dispatchEvent(new dom.window.Event(type, { bubbles: true })));

it("the shortcut opens with the selection, then focuses instead of closing; close returns focus", async () => {
	await mount();
	const lesson = document.querySelector<HTMLInputElement>('[data-testid="lesson"]')!;
	lesson.focus();
	await fire(kbdEventForAction("toggle-side-tutor"));
	assert.equal(tutor()?.getAttribute("data-selected"), "selected lesson text");
	assert.equal(document.querySelector("button")!.getAttribute("aria-expanded"), "true");
	await fire(kbdEventForAction("toggle-side-tutor"));
	assert.ok(tutor(), "a second shortcut press keeps the tutor open");
	assert.ok(document.activeElement === tutor()!.querySelector("textarea"), "the open tutor's input takes focus");
	await fire("lh:close-side-tutor");
	assert.ok(tutor() === null, "the tutor is closed");
	await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
	assert.ok(document.activeElement === lesson, "closing returns focus to the lesson");
});

it("the toolbar button toggles the tutor open and closed", async () => {
	await mount();
	const button = document.querySelector("button")!;
	await fire("click", button);
	assert.ok(tutor());
	await fire("click", button);
	assert.ok(tutor() === null, "the tutor is closed");
	assert.equal(button.getAttribute("aria-expanded"), "false");
});
