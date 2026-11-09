import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

/** The question dock's keys: a folded check never submits on Enter, and an
 *  open modal keeps every key away from the quiz behind it. */
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
});
let focused: Element | null = null;
dom.window.HTMLElement.prototype.focus = function (this: Element) { focused = this; };
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
Object.defineProperty(dom.document, "activeElement", { get: () => focused ?? dom.document.body, configurable: true });
const { QuestionDock } = await import("../components/question-dock.tsx");

const input = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};
const draft = {
	selection: { selected: new Set([1]), otherSelected: false, dontKnow: false },
	thinking: "", other: "", text: "", confidenceIndex: 2,
};

let root: Root | null = null;
const hosts: HTMLElement[] = [];
afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = null;
	for (const h of hosts.splice(0)) h.remove();
	focused = null;
});

async function mount(expanded: boolean, extra = "") {
	const host = document.createElement("div");
	const modal = document.createElement("div");
	modal.innerHTML = extra;
	document.body.append(host, modal);
	hosts.push(host, modal);
	const submits: unknown[] = [];
	root = createRoot(host);
	await act(async () => root!.render(
		<QuestionDock toolName="quiz" toolCallId="q1" input={input as never} expanded={expanded} onExpand={() => {}}
			onSubmit={(a) => submits.push(a)} initialDraft={draft} dictationClaim={false} />,
	));
	return { host, modal, submits };
}

function press(target: EventTarget, init: Record<string, unknown>) {
	const e = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), {
		ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init,
	});
	target.dispatchEvent(e); // linkedom bubbles on through document to window
	return e;
}

describe("Enter on the question dock", () => {
	it("an open check submits its selection on Enter", async () => {
		const { submits } = await mount(true);
		await act(async () => { press(document.body, { key: "Enter" }); });
		assert.equal(submits.length, 1);
	});

	it("a folded check never submits on Enter", async () => {
		const { submits } = await mount(false);
		await act(async () => { press(document.body, { key: "Enter" }); });
		assert.equal(submits.length, 0);
	});
});
