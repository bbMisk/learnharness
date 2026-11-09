import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { parseHTML } from "linkedom";

/** DockOverlay's teach check: Enter on the folded check only reopens it, and
 *  never submits the hidden answer. */
const dom = parseHTML("<!doctype html><html><body></body></html>");
class RO { observe() {} unobserve() {} disconnect() {} }
const raf = (f: FrameRequestCallback) => setTimeout(() => f(0), 0) as unknown as number;
const session = new Map<string, string>();
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: RO,
	getComputedStyle: () => ({ paddingLeft: "0", paddingRight: "0", getPropertyValue: () => "" }),
	requestAnimationFrame: raf, cancelAnimationFrame: (i: number) => clearTimeout(i),
});
Object.assign(dom.window, {
	ResizeObserver: RO, requestAnimationFrame: raf, cancelAnimationFrame: (i: number) => clearTimeout(i),
	sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k) },
});
const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
proto.getAnimations = () => [];
proto.animate = () => ({ cancel() {} });
proto.scrollIntoView = () => {};
proto.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
const { createRoot } = await import("react-dom/client");
const { StickToBottom } = await import("use-stick-to-bottom");
const { DockOverlay } = await import("../components/dock-overlay.tsx");

const pending = {
	key: "q1", toolCallId: "q1", tool: "quiz",
	input: { question: "Which planet is closest?", options: [{ label: "Venus" }, { label: "Mercury" }], correctAnswer: "Mercury", explanation: "x" },
};
const draft = { selection: { selected: new Set([1]), otherSelected: false, dontKnow: false }, thinking: "", other: "", text: "", confidenceIndex: 2 };

function Overlay({ onSubmit, children }: { onSubmit: () => void; children?: React.ReactNode }) {
	return (
		<StickToBottom>
			<StickToBottom.Content>{() => null}</StickToBottom.Content>
			<DockOverlay pending={pending as never} initialQuestionDraft={draft} onSaveQuestionDraft={() => {}} practice={null}
				compactionRunning={false} onSubmitThinking={() => {}} teachingCheck requiresReveal showReadingThinking={false}
				readingThinking="" readingThinkingRevision={0} onReadingThinking={() => {}} phase={"teach" as never} composer={null}
				onSubmitAnswer={onSubmit} footer={null} onReserve={() => {}} room="" queuedSteers={[]} />
			{children}
		</StickToBottom>
	);
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
	session.clear();
});
const isOpen = (host: HTMLElement) => !host.querySelector('[data-testid="teach-check-reveal"]');

it("Enter on the folded check reopens it and submits nothing", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
	let submits = 0;
	await act(async () => root.render(<Overlay onSubmit={() => submits++} />));
	assert.equal(isOpen(host), false);
	// A browser runs microtasks between the document- and window-level
	// listeners of a real key press; dispatch the two phases apart to match.
	const init = { key: "Enter", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
	const docPhase = Object.assign(new dom.window.Event("keydown", { cancelable: true }), init);
	let stopped = false;
	const stop = docPhase.stopPropagation.bind(docPhase);
	docPhase.stopPropagation = () => { stopped = true; stop(); };
	await act(async () => { document.dispatchEvent(docPhase); });
	if (!stopped) await act(async () => { window.dispatchEvent(Object.assign(new dom.window.Event("keydown", { cancelable: true }), init)); });
	assert.equal(isOpen(host), true, "the check reopened");
	assert.equal(submits, 0, "the hidden selection was not submitted");
});
