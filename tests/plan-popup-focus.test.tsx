/** The plan popup is a modal: focus moves in, Tab stays in (the shortcuts'
 *  trap via data-lh-modal), and focus returns to its opener on close. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let focused: Element | null = null;
Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => focused ?? dom.document.body });
Object.assign(dom.window.HTMLElement.prototype, { focus(this: Element) { focused = this; } });
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	requestAnimationFrame: (f: FrameRequestCallback) => setTimeout(() => f(0), 0), cancelAnimationFrame: clearTimeout,
});
const { createRoot } = await import("react-dom/client");
const { PlanPopup } = await import("../components/plan-block.tsx");
const { openModal } = await import("../components/open-modal.ts");
const { trapTab } = await import("../components/keyboard-shortcuts.tsx");

it("focus moves into the plan popup, Tab stays inside it, and closing returns focus to the opener", async () => {
	const host = dom.document.createElement("div");
	dom.document.body.append(host);
	const root = createRoot(host as unknown as HTMLElement);
	function Page({ open }: { open: boolean }) {
		return <><button data-testid="chip">Plan</button>{open && <PlanPopup messages={[]} onClose={() => {}} />}</>;
	}
	try {
		await act(async () => root.render(<Page open={false} />));
		const chip = host.querySelector('[data-testid="chip"]') as unknown as HTMLElement;
		chip.focus();
		await act(async () => root.render(<Page open />));
		const popup = host.querySelector('[data-testid="plan-popup"]') as unknown as HTMLElement;
		assert.ok(dom.document.activeElement === popup, "initial focus is in the popup");
		assert.ok(openModal() === popup, "a modal: the shortcuts trap Tab in it");
		const tab = Object.assign(new dom.window.Event("keydown", { cancelable: true }), { key: "Tab", shiftKey: false }) as unknown as KeyboardEvent;
		trapTab(tab, popup);
		assert.ok(popup.contains(dom.document.activeElement), "Tab lands inside the popup");
		await act(async () => root.render(<Page open={false} />));
		assert.ok(dom.document.activeElement === chip, "focus is back on the opener");
	} finally {
		await act(async () => root.unmount());
	}
});
