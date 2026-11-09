import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { assertSameNode } from "./helpers/same-node.ts";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

// Focus that falls back to the page's composer lands with the caret at the
// end of the draft: after Settings closes with no opener, after a setup save,
// and after the header rename closes by key.
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, Node: dom.window.Node, CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
Object.assign(dom.window.HTMLElement.prototype, { select() {} });

// A minimal Selection (linkedom has none). Like Chrome, focusing a
// contenteditable whose selection is elsewhere puts the caret at its start.
type Range = { startContainer: Node; endContainer: Node; startOffset: number; endOffset: number; cloneRange(): Range };
const at = (node: Node, offset: number): Range => ({ startContainer: node, endContainer: node, startOffset: offset, endOffset: offset, cloneRange() { return at(node, offset); } });
let range: Range | null = null;
const selection = {
	get rangeCount() { return range ? 1 : 0; },
	getRangeAt: () => range!,
	removeAllRanges() { range = null; },
	addRange(r: Range) { range = r; },
	selectAllChildren(node: Node) { range = at(node, 0); Object.assign(range, { endOffset: node.childNodes.length }); },
	collapseToEnd() { if (range) range = at(range.endContainer, range.endOffset); },
};
Object.assign(document, { getSelection: () => selection });
let focused: Element | null = null;
dom.window.HTMLElement.prototype.focus = function (this: HTMLElement) {
	focused = this;
	if (this.isContentEditable && !(range && this.contains(range.startContainer))) range = at(this, 0);
};
Object.defineProperty(dom.document, "activeElement", { get: () => (focused?.isConnected ? focused : dom.document.body), configurable: true });

let root: Root | null = null;
const hosts: HTMLElement[] = [];
const originalFetch = globalThis.fetch;
afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = null;
	for (const host of hosts.splice(0)) host.remove();
	focused = null;
	range = null;
	globalThis.fetch = originalFetch;
});

/** The page's composer with a draft, caret elsewhere (a dialog had focus). */
function composer(): HTMLElement {
	const wrap = document.createElement("div");
	wrap.setAttribute("data-testid", "composer");
	const field = document.createElement("div");
	field.setAttribute("data-file-path-input", "");
	field.textContent = "draft abc";
	Object.defineProperty(field, "isContentEditable", { value: true });
	wrap.append(field);
	document.body.append(wrap);
	hosts.push(wrap);
	range = at(document.body, 0);
	return field;
}

const caretAtEnd = (field: HTMLElement) => range?.endContainer === field && range.startOffset === field.childNodes.length;

it("the composer fallback puts the caret at the end of the draft", async () => {
	const { focusComposer } = await import("../components/focus-return.ts");
	const field = composer();
	focusComposer();
	assert.ok(focused === field);
	assert.ok(caretAtEnd(field), "the caret is after the draft, not before it");
});

it("saving setup hands focus to the composer, caret at the end", async () => {
	const field = composer();
	const pill = document.createElement("button");
	pill.setAttribute("data-testid", "setup-cta");
	document.body.append(pill);
	hosts.push(pill);
	pill.focus();
	const model = {
		id: "fixture-vision", name: "Fixture", provider: "openrouter", reasoning: false, input: ["text", "image"],
		supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
	};
	const pin = { model: { provider: "openrouter", id: "fixture-vision" } };
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const path = new URL(String(input), "http://localhost").pathname;
		if (init?.method === "PUT") return Response.json({ ok: true });
		if (path === "/api/keys") return Response.json({ providers: [], keys: [] });
		return Response.json({ providers: [{ id: "openrouter", envVar: "OPENROUTER_API_KEY", label: "OpenRouter", keyPresent: true }], models: [model], slots: { strong: pin, cheap: pin, vision: pin } });
	}) as typeof fetch;
	const { SetupDialog } = await import("../components/setup-dialog.tsx");
	const host = document.createElement("div");
	document.body.append(host);
	hosts.push(host);
	root = createRoot(host);
	function Harness() {
		const [open, setOpen] = React.useState(true);
		return <SetupDialog open={open} onClose={() => setOpen(false)} onDone={() => setOpen(false)} />;
	}
	await act(async () => { root!.render(<Harness />); });
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
	const save = document.querySelector<HTMLButtonElement>('[data-testid="setup-save"]');
	assert.ok(save && !save.disabled, "the prefilled slots can be saved");
	await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
	assertSameNode(document.querySelector('[data-testid="setup-dialog"]'), null, "setup closed");
	pill.remove(); // the saved models retire the pill
	assert.ok(focused === field, "focus is in the composer, not on the retired pill");
	assert.ok(caretAtEnd(field));
});

it("closing the header rename by key hands focus back to the composer", async () => {
	const { useSessionRename } = await import("../components/session-rename.ts");
	globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
	function Title() {
		const { titleText, renaming, setRenaming, titleDraft, setTitleDraft, titleInputRef, commitRename } = useSessionRename("c1", "Old");
		return renaming ? (
			<input ref={titleInputRef} value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)}
				onKeyDown={(e) => { if (e.key === "Enter") void commitRename(titleDraft); else if (e.key === "Escape") setRenaming(false); }} />
		) : <span>{titleText}</span>;
	}
	const field = composer();
	range = at(field.firstChild!, 5);
	field.focus();
	const host = document.createElement("div");
	document.body.append(host);
	hosts.push(host);
	root = createRoot(host);
	await act(async () => { root!.render(<Title />); });
	for (const key of ["Enter", "Escape"]) {
		await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-rename-session")); });
		const input = host.querySelector("input")!;
		assert.ok(focused === input, "F2 opened the rename");
		range = at(document.body, 0);
		const press = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key });
		await act(async () => { input.dispatchEvent(press); });
		assertSameNode(host.querySelector("input"), null);
		if (key === "Enter") assert.ok(press.defaultPrevented, "Enter types no newline into the composer it hands focus to");
		assert.ok(focused === field, `${key} hands focus back to the composer`);
		assert.ok(range?.startContainer === field.firstChild && range.startOffset === 5, `${key} keeps the caret where it was`);
	}
});

it("a failed header rename keeps the field open with the typed name and says so", async () => {
	const { useSessionRename } = await import("../components/session-rename.ts");
	let fail = true;
	globalThis.fetch = (async () => {
		if (fail) throw new TypeError("Failed to fetch");
		return Response.json({ ok: true });
	}) as typeof fetch;
	const quiet = console.error;
	console.error = () => {};
	function Title() {
		const { titleText, renaming, setRenaming, titleDraft, titleInputRef, commitRename, renameError } = useSessionRename("c1", "Old");
		return renaming ? (
			<>
				{/* Enter commits what the learner typed: "New name". */}
				<input ref={titleInputRef} value={titleDraft} readOnly
					onKeyDown={(e) => { if (e.key === "Enter") void commitRename("New name"); else if (e.key === "Escape") setRenaming(false); }} />
				{renameError && <span role="alert">{renameError}</span>}
			</>
		) : <span data-testid="title">{titleText}</span>;
	}
	composer();
	const host = document.createElement("div");
	document.body.append(host);
	hosts.push(host);
	root = createRoot(host);
	const press = async (key: string) => {
		const input = host.querySelector("input")!;
		await act(async () => {
			input.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key }));
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	};
	const open = () => act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-rename-session")); });
	try {
		await act(async () => { root!.render(<Title />); });
		await open();
		await press("Enter");
		const input = host.querySelector("input");
		assert.equal(input?.value, "New name", "the field stays open with the typed name");
		assert.ok(focused === input, "focus is back in the field");
		assert.equal(host.querySelector('[role="alert"]')?.textContent, "Chat could not be renamed. Try again.");
		await press("Escape");
		assert.equal(host.querySelector('[data-testid="title"]')?.textContent, "Old");
		await open();
		assertSameNode(host.querySelector('[role="alert"]'), null, "a reopened field starts clean");
		fail = false;
		await press("Enter");
		assert.equal(host.querySelector('[data-testid="title"]')?.textContent, "New name");
		assertSameNode(host.querySelector('[role="alert"]'), null);
	} finally {
		console.error = quiet;
	}
});
