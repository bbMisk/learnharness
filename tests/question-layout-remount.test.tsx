/**
 * A question form replaced by a fresh one for the same question (QuestionDock
 * re-keys its form once hydration loads the saved draft) must leave the dock
 * holding the NEW form's layout (fork review, 2026-11-22: after a reload a
 * wide question stayed squeezed into the 46rem dock). The replaced form's
 * "no layout" is a layout-effect cleanup (use-question-layout.ts), so it runs
 * in the commit's mutation phase, before the new form's layout effect
 * reports: the order is deterministic, null first, then the layout.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { QuestionLayoutRequest } from "../components/question-dock.tsx";
import type { QuestionLayout } from "../components/question-layout.ts";
import type { QuizToolInput } from "../src/core/question-core.ts";

// The synthetic geometry seam of question-layout-dock.test.tsx: every box is
// 100px tall and as wide as its inline width.
const dom = parseHTML("<html><body></body></html>");
const style = (el: Element) => ({
	paddingLeft: "16px", paddingRight: "16px", borderLeftWidth: "0px", borderRightWidth: "0px", overflowX: "visible",
	width: (el as HTMLElement).style?.width ?? "",
});
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	getComputedStyle: (el: Element) => style(el),
	ResizeObserver: class { observe() {} disconnect() {} },
	requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", {
	configurable: true,
	value(this: HTMLElement) { return { width: Number.parseFloat(this.style.width) || 0, height: 100 }; },
});

// Imported only now: the layout hooks pick useLayoutEffect at module load
// when a window exists (their SSR fallback is useEffect), and the order
// under test is the browser's.
const { QuestionDock } = await import("../components/question-dock.tsx");

const input = {
	question: "A long question", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
	correctAnswer: "yes", explanation: "Yes is correct.",
} as QuizToolInput;
const request: QuestionLayoutRequest = { available: 1200, base: 702, floor: 368, key: "font" };

/** DockOverlay holds the reports in plain state: whatever was reported last
 *  is what it holds. */
async function setup() {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	const raw: (QuestionLayout | null)[] = [];
	const held = () => raw.at(-1) ?? null;
	const render = (formKey: string, layoutRequest: QuestionLayoutRequest | null = request, show = true) =>
		act(async () => root.render(show
			? <QuestionDock key={formKey} toolName="quiz" toolCallId="q1" input={input} expanded onExpand={() => {}} onSubmit={() => {}}
				dictationClaim={false} layoutRequest={layoutRequest} onLayout={(next) => { raw.push(next); }} />
			: null));
	return { host, root, raw, held, render };
}

test("a form replaced in one commit: the old form's 'no layout' comes first, the dock keeps the new form's layout", async () => {
	const { host, root, raw, held, render } = await setup();
	try {
		await render("server");
		assert.equal(held()?.kind, "columns", "the first form solved two columns");
		const before = raw.length;
		await render("client");
		const remount = raw.slice(before);
		assert.equal(remount.length, 2, "one farewell, one fresh report");
		assert.equal(remount[0], null, "the replaced form's 'no layout' first");
		assert.equal(remount[1]?.kind, "columns", "then the new form's layout");
		assert.equal(host.querySelector('[data-testid="question-dock"]')?.getAttribute("data-question-layout"), "columns");
		assert.equal(held()?.kind, "columns", "the dock still holds the live form's layout");
		assert.equal(held(), remount[1], "the new form's report, not a stale one");
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

test("a real 'no layout' still applies: adaptation turned off, or the question gone", async () => {
	const { host, root, held, render } = await setup();
	try {
		await render("client");
		assert.equal(held()?.kind, "columns");
		await render("client", null);
		assert.equal(held(), null, "adaptation off clears the layout");
		await render("client");
		assert.equal(held()?.kind, "columns");
		await render("client", request, false);
		assert.equal(held(), null, "the question's form unmounting with no replacement clears it");
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});
