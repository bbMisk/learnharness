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

describe("an open modal keeps keys away from the quiz", () => {
	const MODAL = `<div role="dialog" data-lh-modal><button data-testid="nav">General</button></div>`;

	it("Tab, arrows, Space and Enter do nothing to the dock behind a modal", async () => {
		const { host, modal, submits } = await mount(true, MODAL);
		const nav = modal.querySelector<HTMLElement>('[data-testid="nav"]')!;
		nav.focus();
		const before = host.innerHTML;
		for (const key of ["ArrowDown", "Tab", "ArrowRight", " ", "Enter"]) {
			await act(async () => {
				const e = press(nav, { key });
				assert.equal(e.defaultPrevented, false, `${JSON.stringify(key)} left to the modal`);
			});
		}
		assert.equal(focused, nav, "focus stays in the modal");
		assert.equal(host.innerHTML, before, "the dock is unchanged");
		assert.equal(submits.length, 0);
	});

	it("Enter from the page behind a modal submits nothing", async () => {
		const { submits } = await mount(true, MODAL);
		await act(async () => { press(document.body, { key: "Enter" }); });
		assert.equal(submits.length, 0);
	});
});

describe("the dismiss and delete confirms are modals", () => {
	it("the Dismiss this question? confirm is marked modal and takes focus", async () => {
		const { AbortTurnDialog } = await import("../components/abort-turn-dialog.tsx");
		const host = document.createElement("div");
		document.body.append(host);
		hosts.push(host);
		root = createRoot(host);
		await act(async () => root!.render(<AbortTurnDialog mode="question" onClose={() => {}} onConfirm={() => {}} />));
		const dialog = document.querySelector<HTMLElement>('[data-testid="abort-turn-dialog"]')!;
		assert.ok(dialog.hasAttribute("data-lh-modal"));
		assert.ok(focused && dialog.contains(focused), "focus moves into the confirm");
		await act(async () => root!.unmount());
		root = null;
	});

	it("the Delete session? dialog is marked modal and takes focus", async () => {
		const { DeleteSessionDialog } = await import("../components/delete-session-dialog.tsx");
		const host = document.createElement("div");
		document.body.append(host);
		hosts.push(host);
		root = createRoot(host);
		await act(async () => root!.render(<DeleteSessionDialog chat={{ id: "c1", title: "DRW" }} onClose={() => {}} onDeleted={() => {}} />));
		const dialog = document.querySelector<HTMLElement>('[data-testid="delete-session-dialog"]')!;
		assert.ok(dialog.hasAttribute("data-lh-modal"));
		assert.ok(focused && dialog.contains(focused), "focus moves into the dialog");
		await act(async () => root!.unmount());
		root = null;
	});
});

describe("every overlay over the dock is a modal", () => {
	// Each overlay mounted beside an open check: arrows, Space and Enter
	// from the page change nothing behind it.
	async function keysBehind(overlay: React.ReactElement, testid: string) {
		const { host, submits } = await mount(true);
		const layer = document.createElement("div");
		document.body.append(layer);
		hosts.push(layer);
		const overlayRoot = createRoot(layer);
		await act(async () => overlayRoot.render(overlay));
		const el = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
		assert.ok(el?.hasAttribute("data-lh-modal"), `${testid} is marked modal`);
		const before = host.innerHTML;
		for (const key of ["ArrowRight", "ArrowDown", " ", "Enter"]) {
			await act(async () => { press(document.body, { key }); });
		}
		assert.equal(host.innerHTML, before, `${testid}: the dock is unchanged`);
		assert.equal(submits.length, 0, `${testid}: nothing submitted`);
		await act(async () => overlayRoot.unmount());
	}

	it("the Diagram and figure focus", async () => {
		const { MermaidOverlay } = await import("../components/session-overlay.tsx");
		await keysBehind(<MermaidOverlay svg="<svg viewBox='0 0 10 10'/>" onClose={() => {}} />, "mermaid-overlay");
	});

	it("the delete node and delete sources confirms", async () => {
		const { DeleteNodeDialog } = await import("../components/delete-node-dialog.tsx");
		const { DeleteSourceDialog } = await import("../components/delete-source-dialog.tsx");
		await keysBehind(<DeleteNodeDialog nodes={[{ id: "n1", name: "Energy" }]} onClose={() => {}} onDeleted={() => {}} />, "delete-node-dialog");
		await keysBehind(<DeleteSourceDialog open sources={[]} folders={[{ id: "f1", name: "Old" } as never]} onDelete={async () => {}} onClose={() => {}} />, "delete-source-dialog");
	});
});

describe("cancelling the Dismiss confirm", () => {
	it("hands focus back to the field it came from", async () => {
		const { AbortTurnDialog } = await import("../components/abort-turn-dialog.tsx");
		const host = document.createElement("div");
		const field = document.createElement("div");
		document.body.append(field, host);
		hosts.push(field, host);
		field.focus();
		root = createRoot(host);
		const render = (mode: "question" | null) => act(async () => root!.render(<AbortTurnDialog mode={mode} onClose={() => {}} onConfirm={() => {}} />));
		await render("question");
		assert.notEqual(focused, field, "the confirm took focus");
		await render(null);
		assert.equal(focused, field);
	});
});
