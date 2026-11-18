import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { assertSameNode, assertNotSameNode } from "./helpers/same-node.ts";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { parseHTML } from "linkedom";

/** The question dock's keys: a folded check never submits on Enter, and an
 *  open modal keeps every key away from the quiz behind it. */
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	// The confirms are HostDialogs: their focus scope and scroll lock need these.
	Event: dom.window.Event, MutationObserver: dom.window.MutationObserver, NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
});
Object.assign(dom.window, { getComputedStyle: (element: HTMLElement) => ({
	display: element.style.display || "block", visibility: element.style.visibility || "visible",
	paddingLeft: "0px", paddingRight: "0px", marginLeft: "0px", marginRight: "0px", borderLeftWidth: "0px", borderRightWidth: "0px",
	getPropertyValue: () => "",
}) });
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
	// A closed HostDialog returns focus a tick later: let it land here, not in the next test.
	await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
	focused = null;
});

/** The dock alone (its fallback reads the raw data-lh-modal markers in
 *  `extra`), or with `overlay` beside it under one interaction-layer
 *  provider, as AppShell mounts them. */
async function mount(expanded: boolean, extra = "", overlay?: React.ReactElement) {
	const host = document.createElement("div");
	const modal = document.createElement("div");
	modal.innerHTML = extra;
	document.body.append(host, modal);
	hosts.push(host, modal);
	const submits: unknown[] = [];
	root = createRoot(host);
	const dock = <QuestionDock toolName="quiz" toolCallId="q1" input={input as never} expanded={expanded} onExpand={() => {}}
		onSubmit={(a) => submits.push(a)} initialDraft={draft} dictationClaim={false} />;
	const show = (next?: React.ReactElement) => act(async () => root!.render(<InteractionLayersProvider>{dock}{next}</InteractionLayersProvider>));
	if (overlay) await show(overlay);
	else await act(async () => root!.render(dock));
	return { host, modal, submits, show };
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
		assertSameNode(focused, nav, "focus stays in the modal");
		assert.equal(host.innerHTML, before, "the dock is unchanged");
		assert.equal(submits.length, 0);
	});

	it("under the app's interaction layers too, an unregistered data-lh-modal (a Radix dialog) keeps every key off the dock", async () => {
		// The provider's capture prevents every native Tab (Tab is dead app-wide),
		// so only the dock's own state is asserted here.
		const { host, modal, submits } = await mount(true, MODAL, <></>);
		const nav = modal.querySelector<HTMLElement>('[data-testid="nav"]')!;
		nav.focus();
		const before = host.innerHTML;
		for (const target of [nav, document.body]) {
			for (const key of ["ArrowDown", "Tab", "ArrowRight", " ", "Enter"]) await act(async () => { press(target, { key }); });
		}
		assertSameNode(focused, nav, "focus stays in the modal");
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
		await act(async () => root!.render(<InteractionLayersProvider><AbortTurnDialog mode="question" onClose={() => {}} onConfirm={() => {}} /></InteractionLayersProvider>));
		const dialog = document.querySelector<HTMLElement>('[data-testid="abort-turn-dialog"]')!;
		// A HostDialog: its boundary is the modal marker (open-modal's
		// openModal() and the layer controller read it), not data-lh-modal.
		const { openModal } = await import("../components/open-modal.ts");
		assert.ok(openModal()?.contains(dialog), "the confirm is the open modal");
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
		await act(async () => root!.render(<InteractionLayersProvider><DeleteSessionDialog chat={{ id: "c1", title: "DRW" }} onClose={() => {}} onDeleted={() => {}} /></InteractionLayersProvider>));
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
		const { host, submits, show } = await mount(true, "", overlay);
		const el = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
		assert.ok(el?.hasAttribute("data-lh-modal"), `${testid} is marked modal`);
		const before = host.innerHTML;
		for (const key of ["ArrowRight", "ArrowDown", " ", "Enter"]) {
			await act(async () => { press(document.body, { key }); });
		}
		assert.equal(host.innerHTML, before, `${testid}: the dock is unchanged`);
		assert.equal(submits.length, 0, `${testid}: nothing submitted`);
		await show();
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
		const render = (mode: "question" | null) => act(async () => root!.render(<InteractionLayersProvider><AbortTurnDialog mode={mode} onClose={() => {}} onConfirm={() => {}} /></InteractionLayersProvider>));
		await render("question");
		assertNotSameNode(focused, field, "the confirm took focus");
		await render(null);
		assertSameNode(focused, field);
	});

	it("after a backdrop click, the caret goes back where it was in the field, not to its start", async () => {
		const { AbortTurnDialog } = await import("../components/abort-turn-dialog.tsx");
		const host = document.createElement("div");
		const field = document.createElement("div");
		field.textContent = "hello world";
		Object.defineProperty(field, "isContentEditable", { value: true });
		document.body.append(field, host);
		hosts.push(field, host);
		// A minimal Selection: linkedom has none.
		const at = (node: Node, offset: number) => ({ startContainer: node, endContainer: node, startOffset: offset, endOffset: offset, cloneRange() { return at(node, offset); } });
		let range: ReturnType<typeof at> | null = at(field.firstChild!, 11);
		const selection = {
			get rangeCount() { return range ? 1 : 0; },
			getRangeAt: () => range!,
			removeAllRanges() { range = null; },
			addRange(r: ReturnType<typeof at>) { range = r; },
			selectAllChildren(node: Node) { range = at(node, node.childNodes.length); },
			collapseToEnd() {},
		};
		const getSelection = document.getSelection;
		Object.assign(document, { getSelection: () => selection });
		try {
			field.focus();
			root = createRoot(host);
			const render = (mode: "question" | null) => act(async () => root!.render(<InteractionLayersProvider><AbortTurnDialog mode={mode} onClose={() => {}} onConfirm={() => {}} /></InteractionLayersProvider>));
			await render("question");
			range = at(document.body, 0); // the backdrop's mousedown moved the selection
			await render(null);
			assertSameNode(focused, field);
			assert.ok(range?.startContainer === field.firstChild, "the caret is back in the field"); // equal() would diff whole DOM trees
			assert.equal(range?.startOffset, 11, "after hello world, where it was");
		} finally {
			Object.assign(document, { getSelection });
		}
	});
});

it("every dialog focus return goes through the shared caret-keeping helper", async () => {
	const { readFileSync } = await import("node:fs");
	for (const file of ["abort-turn-dialog.tsx", "settings/settings-dialog-body.tsx", "setup-dialog.tsx", "plan-block.tsx"]) {
		const source = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8");
		assert.match(source, /useFocusReturn\(/, file);
		assert.doesNotMatch(source, /opener\.focus\(/, file);
	}
});
