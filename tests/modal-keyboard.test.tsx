import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { assertSameNode } from "./helpers/same-node.ts";
import { afterEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";

// A modal (Settings, setup) owns the keyboard: Tab cycles inside it and the
// global shortcuts never act on the page behind it.
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});
// linkedom has no focus model: track the last focus() call.
let focused: Element | null = null;
dom.window.HTMLElement.prototype.focus = function (this: Element) { focused = this; };
Object.defineProperty(dom.document, "activeElement", { get: () => focused, configurable: true });
let keymap: string | null = null;
Object.assign(dom.window, { localStorage: { getItem: () => keymap, setItem: () => {}, removeItem: () => {} } });
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
const { createRoot } = await import("react-dom/client");
const { KeyboardShortcuts } = await import("../components/keyboard-shortcuts.tsx");

const pushes: string[] = [];
const router = { push: (href: string) => pushes.push(href), replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
let root: Root | null = null;
const hosts: HTMLElement[] = [];

afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = null;
	for (const host of hosts.splice(0)) host.remove();
	pushes.length = 0;
	focused = null;
	keymap = null;
});

async function mount(modalHtml: string) {
	const page = document.createElement("div");
	page.innerHTML = `<textarea data-testid="composer"></textarea>`;
	const modal = document.createElement("div");
	modal.innerHTML = modalHtml;
	const host = document.createElement("div");
	document.body.append(page, modal, host);
	hosts.push(page, modal, host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={router as never}>
				<PathnameContext.Provider value="/chat/x">
					<KeyboardShortcuts />
				</PathnameContext.Provider>
			</AppRouterContext.Provider>,
		);
	});
}

function press(init: Record<string, unknown>) {
	const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), {
		ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: "", ...init,
	});
	window.dispatchEvent(event);
	return event;
}

const MODAL = `<div role="dialog" aria-modal="true" data-lh-modal><button data-testid="a">a</button><input data-testid="b"><button data-testid="c" disabled>c</button></div>`;

describe("an open modal owns the keyboard", () => {
	it("Tab cycles the modal's controls, wrapping, and never the page's fields", async () => {
		await mount(MODAL);
		const fields: string[] = [];
		const onCycle = () => fields.push("cycle");
		window.addEventListener("lh:kbd-cycle-fields", onCycle);
		try {
			const tab = press({ key: "Tab", code: "Tab" });
			assert.equal(tab.defaultPrevented, true);
			assert.equal((document.activeElement as HTMLElement | null)?.dataset.testid, "a", "focus behind the modal moves into it");
			press({ key: "Tab", code: "Tab" });
			assert.equal((document.activeElement as HTMLElement | null)?.dataset.testid, "b");
			press({ key: "Tab", code: "Tab" });
			assert.equal((document.activeElement as HTMLElement | null)?.dataset.testid, "a", "wraps, skipping disabled controls");
			press({ key: "Tab", code: "Tab", shiftKey: true });
			assert.equal((document.activeElement as HTMLElement | null)?.dataset.testid, "b", "Shift+Tab goes backward");
			assert.deepEqual(fields, []);
		} finally {
			window.removeEventListener("lh:kbd-cycle-fields", onCycle);
		}
	});

	it("global shortcuts (jump to graph, model picker) do nothing behind the modal", async () => {
		await mount(MODAL);
		const picked: string[] = [];
		const onPicker = () => picked.push("picker");
		window.addEventListener("lh:kbd-open-model-picker", onPicker);
		try {
			press({ key: "g", code: "KeyG", metaKey: true, ctrlKey: true });
			press({ key: "g", code: "KeyG", metaKey: true });
			press({ key: "k", code: "KeyK", metaKey: true });
			press({ key: "k", code: "KeyK", ctrlKey: true });
			assert.deepEqual(pushes, []);
			assert.deepEqual(picked, []);
		} finally {
			window.removeEventListener("lh:kbd-open-model-picker", onPicker);
		}
	});

	it("without a modal the same shortcut still fires", async () => {
		await mount("");
		const picked: string[] = [];
		const onPicker = () => picked.push("picker");
		window.addEventListener("lh:kbd-open-model-picker", onPicker);
		try {
			press({ key: "k", code: "KeyK", metaKey: true });
			press({ key: "k", code: "KeyK", ctrlKey: true });
			assert.ok(picked.length >= 1);
		} finally {
			window.removeEventListener("lh:kbd-open-model-picker", onPicker);
		}
	});
});

describe("shortcuts from a text field", () => {
	it("an F-key binding fires from the composer; a bare key stays in the field", async () => {
		await mount("");
		const composer = document.querySelector<HTMLElement>('[data-testid="composer"]')!;
		const renames: string[] = [];
		const onRename = () => renames.push("rename");
		window.addEventListener("lh:kbd-rename-session", onRename);
		try {
			const typed = (init: Record<string, unknown>) => composer.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), {
				ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init,
			}));
			await act(async () => { typed({ key: "F2", code: "F2" }); });
			assert.deepEqual(renames, ["rename"]);
			await act(async () => { typed({ key: "?", code: "Slash", shiftKey: true }); });
			assertSameNode(document.querySelector('[data-testid="cheat-sheet"]'), null);
		} finally {
			window.removeEventListener("lh:kbd-rename-session", onRename);
		}
	});
});

describe("⌥ shortcuts from a text field", () => {
	it("a bound ⌥ chord fires and doesn't type its glyph; an unbound one and ⌘ chords type as before", async () => {
		keymap = JSON.stringify({ "toggle-sidebar": "alt+/" });
		await mount("");
		const composer = document.querySelector<HTMLElement>('[data-testid="composer"]')!;
		const toggles: string[] = [];
		const onToggle = () => toggles.push("toggle");
		window.addEventListener("lh:kbd-toggle-sidebar", onToggle);
		try {
			const typed = (init: Record<string, unknown>) => {
				const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), {
					ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init,
				});
				composer.dispatchEvent(event);
				return event;
			};
			let event!: Event;
			await act(async () => { event = typed({ key: "÷", code: "Slash", altKey: true }); });
			assert.deepEqual(toggles, ["toggle"]);
			assert.equal(event.defaultPrevented, true, "the glyph stays out of the draft");
			await act(async () => { event = typed({ key: "¡", code: "Digit1", altKey: true }); });
			assert.equal(event.defaultPrevented, false, "an unbound ⌥ glyph still types");
			await act(async () => { event = typed({ key: "k", code: "KeyK", metaKey: true }); });
			assert.equal(event.defaultPrevented, false, "⌘ chords keep their old handling");
		} finally {
			window.removeEventListener("lh:kbd-toggle-sidebar", onToggle);
		}
	});
});

describe("shortcuts from a rename field", () => {
	it("F-keys stay out of a field that is mid-rename", async () => {
		await mount("");
		const field = document.createElement("input");
		field.setAttribute("data-testid", "session-rename-input");
		field.setAttribute("data-lh-rename", "");
		document.body.append(field);
		hosts.push(field);
		const renames: string[] = [];
		const onRename = () => renames.push("rename");
		window.addEventListener("lh:kbd-rename-session", onRename);
		try {
			await act(async () => {
				field.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), {
					key: "F2", code: "F2", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
				}));
			});
			assert.deepEqual(renames, []);
		} finally {
			window.removeEventListener("lh:kbd-rename-session", onRename);
		}
	});
});

describe("the shortcut cheat sheet is a modal", () => {
	it("? opens it marked modal, global shortcuts stay out, and Esc still closes it", async () => {
		await mount("");
		await act(async () => { press({ key: "?", code: "Slash", shiftKey: true }); });
		const sheet = document.querySelector<HTMLElement>('[data-testid="cheat-sheet"]');
		assert.ok(sheet?.hasAttribute("data-lh-modal"));
		const picked: string[] = [];
		const onPicker = () => picked.push("picker");
		window.addEventListener("lh:kbd-open-model-picker", onPicker);
		try {
			press({ key: "k", code: "KeyK", metaKey: true });
			press({ key: "k", code: "KeyK", ctrlKey: true });
			assert.deepEqual(picked, []);
		} finally {
			window.removeEventListener("lh:kbd-open-model-picker", onPicker);
		}
		const aborts: string[] = [];
		const onAbort = () => aborts.push("abort");
		window.addEventListener("lh:kbd-abort-turn", onAbort);
		try {
			let esc: Event | null = null;
			await act(async () => { esc = press({ key: "Escape", code: "Escape" }); });
			assert.equal(esc!.defaultPrevented, true);
			assertSameNode(document.querySelector('[data-testid="cheat-sheet"]'), null, "Esc closes it");
			assert.deepEqual(aborts, [], "the Esc never reaches the abort chain");
		} finally {
			window.removeEventListener("lh:kbd-abort-turn", onAbort);
		}
	});

	it("takes focus, covers the page chrome, names an unbound action, and hands focus back on Esc", async () => {
		await mount("");
		const table = document.createElement("div");
		table.setAttribute("data-testid", "chain-table");
		const band = document.createElement("div");
		band.setAttribute("data-testid", "update-band");
		document.body.append(table, band);
		hosts.push(table, band);
		table.focus();
		await act(async () => { press({ key: "?", code: "Slash", shiftKey: true }); });
		const sheet = document.querySelector<HTMLElement>('[data-testid="cheat-sheet"]')!;
		assert.ok(sheet.contains(document.activeElement), "focus moves into the sheet");
		assertSameNode(document.body.lastElementChild, sheet, "portaled after the update band and the offline strip");
		const row = [...sheet.querySelectorAll("div")].find((d) => d.firstElementChild?.textContent === "Toggle dictation")!;
		assert.equal(row.querySelector("kbd")?.textContent, "Not bound");
		await act(async () => { press({ key: "Escape", code: "Escape" }); });
		assertSameNode(document.querySelector('[data-testid="cheat-sheet"]'), null);
		assertSameNode(document.activeElement, table, "focus goes back to what had it");
	});
});
