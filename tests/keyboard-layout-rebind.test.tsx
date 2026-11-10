import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { assertSameNode } from "./helpers/same-node.ts";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import { KeyboardSection } from "../components/settings/keyboard-section.tsx";
import { actionForBinding, eventBinding, loadOverrides } from "../src/core/keyboard.ts";
import { useDoubleClickGuard } from "../components/double-click-tail.ts";
import { windowCaptureClicks } from "./helpers/window-capture-click.ts";

const { window, document } = parseHTML("<html><body></body></html>");
const storage = new Map<string, string>();
Object.assign(window, { localStorage: {
	getItem: (key: string) => storage.get(key) ?? null,
	setItem: (key: string, value: string) => { storage.set(key, value); },
	removeItem: (key: string) => { storage.delete(key); },
} });
Object.assign(globalThis, { window, document, Element: window.Element });
windowCaptureClicks(window as unknown as Window & typeof globalThis);
/** AppShell's app-wide guard: the second click of a double click never reaches a control. */
function DoubleClickGuard() { useDoubleClickGuard(); return null; }
const roots: { root: Root; host: HTMLElement }[] = [];

async function mount() {
	const host = document.createElement("div") as unknown as HTMLElement;
	document.body.append(host);
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => { root.render(<><DoubleClickGuard /><KeyboardSection /></>); });
	return host;
}

async function click(host: HTMLElement, id: string) {
	const button = host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	assert.ok(button);
	await act(async () => { button.click(); });
}

async function press(init: { key: string; code: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }) {
	const event = Object.assign(new window.Event("keydown", { bubbles: true, cancelable: true }), {
		ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init,
	});
	await act(async () => { window.dispatchEvent(event); });
	return event;
}

function binding(init: Parameters<typeof press>[0]) {
	return eventBinding({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init } as KeyboardEvent);
}

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); });
		host.remove();
	}
	storage.clear();
});

describe("keyboard rebind shares layout normalization with dispatch", () => {
	it("captures a Russian modified key as an ordinary binding and resets it normally", async () => {
		const host = await mount();
		await click(host, "kbd-rebind-find");
		const event = await press({ key: "л", code: "KeyK", ctrlKey: true, shiftKey: true });
		assert.equal(event.defaultPrevented, true, "capture must not type the layout character");
		assert.deepEqual(loadOverrides(), { find: "mod+shift+k" });
		assert.equal(actionForBinding(binding({ key: "K", code: "KeyK", metaKey: true, shiftKey: true })), "find");
		await click(host, "kbd-reset-find");
		assert.deepEqual(loadOverrides(), {});
		assert.equal(actionForBinding("mod+f"), "find");
	});

	it("captures Alt/Option physical fallback and matches another non-ASCII layout", async () => {
		const host = await mount();
		await click(host, "kbd-rebind-open-model-picker");
		await press({ key: "˚", code: "KeyK", altKey: true });
		assert.deepEqual(loadOverrides(), { "open-model-picker": "alt+k" });
		assert.equal(actionForBinding(binding({ key: "л", code: "KeyK", altKey: true })), "open-model-picker");
		assert.equal(actionForBinding(binding({ key: "k", code: "KeyK", altKey: true })), "open-model-picker");
	});

	it("still ignores modifier-only keydowns, cancels with Escape, and keeps bare keys unmapped", async () => {
		const host = await mount();
		await click(host, "kbd-rebind-find");
		await press({ key: "Control", code: "ControlLeft", ctrlKey: true });
		assert.deepEqual(loadOverrides(), {});
		assert.ok(host.textContent!.includes("Press keys…"));
		await press({ key: "Escape", code: "Escape" });
		assert.deepEqual(loadOverrides(), {});
		assert.ok(!host.textContent!.includes("Press keys…"));
		assert.equal(binding({ key: "л", code: "KeyK" }), "л", "a bare key keeps its layout character");
	});

	it("refuses system and editing chords and bare keys, but allows F keys and the action's own default", async () => {
		const host = await mount();
		const alert = () => host.querySelector('[data-testid="kbd-row-new-session"] [role="alert"]')?.textContent ?? "";
		for (const init of [
			{ key: "c", code: "KeyC", metaKey: true },
			{ key: "w", code: "KeyW", metaKey: true },
			{ key: "s", code: "KeyS" },
			{ key: "Backspace", code: "Backspace" },
		]) {
			await click(host, "kbd-rebind-new-session");
			await press(init);
			assert.deepEqual(loadOverrides(), {}, `${init.key} must be refused`);
			assert.match(alert(), /reserved|needs/);
		}
		await click(host, "kbd-rebind-new-session");
		await press({ key: "F4", code: "F4" });
		assert.deepEqual(loadOverrides(), { "new-session": "f4" });
		assert.equal(alert(), "");
		await click(host, "kbd-rebind-cheat-sheet");
		await press({ key: "?", code: "Slash", shiftKey: true });
		assertSameNode(host.querySelector('[data-testid="kbd-row-cheat-sheet"] [role="alert"]'), null, "? stays allowed for the cheat sheet");
	});

	it("Reset all to defaults needs a second click", async () => {
		const host = await mount();
		await click(host, "kbd-rebind-new-session");
		await press({ key: "F4", code: "F4" });
		await click(host, "kbd-reset-all");
		assert.deepEqual(loadOverrides(), { "new-session": "f4" }, "one click only arms the reset");
		assert.equal(host.querySelector('[data-testid="kbd-reset-all"]')?.textContent, "Confirm reset all");
		await click(host, "kbd-reset-all");
		assert.deepEqual(loadOverrides(), {});
	});

	it("a double click on Reset all only arms it (its second click has detail 2)", async () => {
		const host = await mount();
		await click(host, "kbd-rebind-new-session");
		await press({ key: "F4", code: "F4" });
		const button = host.querySelector<HTMLElement>('[data-testid="kbd-reset-all"]')!;
		for (const detail of [1, 2]) {
			await act(async () => { button.dispatchEvent(Object.assign(new window.Event("click", { bubbles: true, cancelable: true }), { button: 0, detail })); });
		}
		assert.deepEqual(loadOverrides(), { "new-session": "f4" }, "the double click did not reset");
		assert.equal(button.textContent, "Confirm reset all");
		await click(host, "kbd-reset-all");
		assert.deepEqual(loadOverrides(), {}, "a separate click still confirms");
	});

	it("cancelling a rebind by Cancel or Esc clears the row's earlier conflict", async () => {
		const host = await mount();
		const alert = () => host.querySelector('[data-testid="kbd-row-jump-graph"] [role="alert"]')?.textContent ?? "";
		for (const cancel of ["button", "escape"] as const) {
			await click(host, "kbd-rebind-jump-graph");
			await press({ key: "b", code: "KeyB", metaKey: true });
			assert.match(alert(), /already used by/);
			await click(host, "kbd-rebind-jump-graph");
			if (cancel === "button") await click(host, "kbd-rebind-jump-graph");
			else await press({ key: "Escape", code: "Escape" });
			assert.equal(alert(), "", `${cancel} clears the conflict`);
		}
	});

	it("refuses a binding another action already uses, and says which", async () => {
		const host = await mount();
		await click(host, "kbd-rebind-jump-graph");
		await press({ key: "b", code: "KeyB", metaKey: true });
		assert.deepEqual(loadOverrides(), {}, "Graph view keeps its own binding");
		assert.match(host.querySelector('[data-testid="kbd-row-jump-graph"] [role="alert"]')?.textContent ?? "", /already used by Toggle chats sidebar/);
		assert.equal(actionForBinding("mod+b"), "toggle-sidebar");
	});
});

describe("⌥ bindings saved by older builds", () => {
	it("load in the recorder's physical-key spelling, and a dead key reads as not bound", async () => {
		storage.set("lh:keymap", JSON.stringify({
			"toggle-sidebar": "alt+÷", "new-session": "alt+¡", "toggle-dictation": "alt+ ",
			"jump-graph": "mod+alt+≥", "find": "alt+shift+¿", "cheat-sheet": "alt+dead",
			// Already in today's spelling: left alone.
			"open-settings": "alt+§", "rename-session": "mod+ю", "open-model-picker": "alt+k",
		}));
		assert.deepEqual(loadOverrides(), {
			"toggle-sidebar": "alt+/", "new-session": "alt+1", "toggle-dictation": "alt+ ",
			"jump-graph": "mod+alt+.", "find": "alt+shift+/", "cheat-sheet": "",
			"open-settings": "alt+§", "rename-session": "mod+ю", "open-model-picker": "alt+k",
		});
		assert.equal(actionForBinding(binding({ key: "÷", code: "Slash", altKey: true })), "toggle-sidebar");
		assert.equal(actionForBinding(binding({ key: "¡", code: "Digit1", altKey: true })), "new-session");
		assert.equal(actionForBinding(binding({ key: " ", code: "Space", altKey: true })), "toggle-dictation");
		assert.equal(actionForBinding(binding({ key: "Dead", code: "KeyE", altKey: true })), undefined);
		assert.equal(actionForBinding("?"), undefined, "the dead-key action doesn't fall back to its default");
		const host = await mount();
		assert.equal(host.querySelector('[data-testid="kbd-row-cheat-sheet"] kbd')?.textContent, "Not bound");
	});
});

describe("rebind and reset keep focus on the row", () => {
	it("the Rebind button stays the same element through a capture, and Reset hands focus to it", async () => {
		const host = await mount();
		let focused: Element | null = null;
		window.HTMLElement.prototype.focus = function (this: Element) { focused = this; };
		const rebind = host.querySelector<HTMLElement>('[data-testid="kbd-rebind-find"]')!;
		await click(host, "kbd-rebind-find");
		assert.ok(rebind.isConnected, "capturing keeps the focused button in place");
		const label = () => rebind.textContent;
		assert.equal(label(), "Cancel");
		await press({ key: "k", code: "KeyK", ctrlKey: true, shiftKey: true });
		assert.ok(rebind.isConnected && label() === "Rebind");
		const reset = host.querySelector<HTMLElement>('[data-testid="kbd-reset-find"]')!;
		Object.defineProperty(document, "activeElement", { get: () => reset, configurable: true });
		await click(host, "kbd-reset-find");
		assert.ok(focused === rebind, "Reset's removal hands focus to the row's Rebind");
	});
});
