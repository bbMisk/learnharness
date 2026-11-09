import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});
// React listens for input events only when the document advertises oninput.
Object.assign(dom.document, { oninput: null });
const { createRoot } = await import("react-dom/client");
const { CommitInput } = await import("../components/settings/controls.tsx");

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
	await act(async () => { root?.unmount(); });
	host?.remove();
	root = null;
	host = null;
});

async function mount(onCommit: (v: string) => void) {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => { root!.render(<CommitInput value="20" ariaLabel="limit" testid="input" onCommit={onCommit} />); });
	return host.querySelector("input") as HTMLInputElement;
}

async function fire(target: EventTarget, type: string, init: Record<string, unknown> = {}) {
	const event = Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), init);
	await act(async () => { target.dispatchEvent(event); });
}

async function type(input: HTMLInputElement, value: string) {
	// React tracks the last value it saw; set through the prototype setter so
	// the input event registers as a change.
	Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
	await fire(input, "input");
}

describe("CommitInput Esc", () => {
	it("Esc while editing reverts the draft, commits nothing, and does not reach the dialog", async () => {
		const commits: string[] = [];
		let dialogEsc = 0;
		const onDoc = (e: Event) => { if ((e as KeyboardEvent).key === "Escape") dialogEsc++; };
		document.addEventListener("keydown", onDoc);
		try {
			const input = await mount((v) => commits.push(v));
			await type(input, "55");
			assert.equal(input.value, "55");
			await fire(input, "keydown", { key: "Escape" });
			await fire(input, "focusout");
			assert.deepEqual(commits, []);
			assert.equal(dialogEsc, 0);
			assert.equal(input.value, "20");
			// The next edit still commits on blur.
			await type(input, "30");
			await fire(input, "focusout");
			assert.deepEqual(commits, ["30"]);
		} finally {
			document.removeEventListener("keydown", onDoc);
		}
	});
});
