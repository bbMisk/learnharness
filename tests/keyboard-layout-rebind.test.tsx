import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import { KeyboardSection } from "../components/settings/keyboard-section.tsx";
import { actionForBinding, eventBinding, loadOverrides } from "../src/core/keyboard.ts";

const { window, document } = parseHTML("<html><body></body></html>");
const storage = new Map<string, string>();
Object.assign(window, { localStorage: {
	getItem: (key: string) => storage.get(key) ?? null,
	setItem: (key: string, value: string) => { storage.set(key, value); },
	removeItem: (key: string) => { storage.delete(key); },
} });
Object.assign(globalThis, { window, document });
const roots: { root: Root; host: HTMLElement }[] = [];

async function mount() {
	const host = document.createElement("div") as unknown as HTMLElement;
	document.body.append(host);
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => { root.render(<KeyboardSection />); });
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
		assert.equal(host.querySelector('[data-testid="kbd-row-cheat-sheet"] [role="alert"]'), null, "? stays allowed for the cheat sheet");
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

	it("refuses a binding another action already uses, and says which", async () => {
		const host = await mount();
		await click(host, "kbd-rebind-jump-graph");
		await press({ key: "b", code: "KeyB", metaKey: true });
		assert.deepEqual(loadOverrides(), {}, "Graph view keeps its own binding");
		assert.match(host.querySelector('[data-testid="kbd-row-jump-graph"] [role="alert"]')?.textContent ?? "", /already used by Toggle sessions sidebar/);
		assert.equal(actionForBinding("mod+b"), "toggle-sidebar");
	});
});
