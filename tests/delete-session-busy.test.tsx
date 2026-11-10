/** The chat delete dialog while its DELETE is in flight: Esc can't close it,
 *  a failure then shows in the dialog, and Delete keeps focus throughout. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	self: globalThis,
});
const { DeleteSessionDialog } = await import("../components/delete-session-dialog.tsx");

let finish: (response: Response) => void = () => {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Promise<Response>((resolve) => (finish = resolve))) as typeof fetch;
after(() => {
	globalThis.fetch = realFetch;
});

it("Esc is ignored while deleting; a failure shows in the dialog with Delete still focusable, and Try again keeps focus", async () => {
	let closes = 0;
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () =>
		root.render(<DeleteSessionDialog chat={{ id: "chat_x", title: "Waves" }} onClose={() => closes++} onDeleted={() => {}} />),
	);
	const confirm = () => document.querySelector('[data-testid="delete-confirm"]')!;
	await act(async () => (confirm() as HTMLElement).click());
	assert.equal(confirm().textContent, "Delete", "a confirm right after opening is the opener's tail (Enter twice)");
	await new Promise((resolve) => setTimeout(resolve, 550));
	await act(async () => (confirm() as HTMLElement).click());
	assert.equal(confirm().textContent, "Deleting…");
	const esc = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" });
	await act(async () => void document.dispatchEvent(esc));
	assert.equal(closes, 0, "Esc does not close a busy dialog");
	assert.equal(esc.defaultPrevented, true, "but is still claimed");
	// A disabled button would drop focus to <body>.
	assert.ok(!confirm().hasAttribute("disabled") && confirm().getAttribute("aria-disabled") === "true", "Delete stays focusable while busy");
	await act(async () => finish(Response.json({ code: "turn_in_flight", error: "A turn is running." }, { status: 409 })));
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
	assert.equal(document.querySelector('[data-testid="delete-failure"]')?.textContent?.includes("A turn is running."), true, "the failure shows");
	assert.ok(!confirm().hasAttribute("disabled") && confirm().getAttribute("aria-disabled") === "false");
	// Try again unmounts as the retry starts: focus moves to Delete, not <body>.
	const focused: Element[] = [];
	const realFocus = dom.window.HTMLElement.prototype.focus;
	dom.window.HTMLElement.prototype.focus = function (this: Element) {
		focused.push(this);
	};
	try {
		await act(async () => (document.querySelector('[data-testid="delete-retry"]') as HTMLElement).click());
	} finally {
		dom.window.HTMLElement.prototype.focus = realFocus;
	}
	assert.ok(focused.length === 1 && focused[0] === confirm(), "focus moves to Delete");
	await act(async () => finish(Response.json({ code: "turn_in_flight", error: "A turn is running." }, { status: 409 })));
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
	await act(async () => void document.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" })));
	assert.equal(closes, 1, "Esc closes it once idle");
	await act(async () => root.unmount());
});
