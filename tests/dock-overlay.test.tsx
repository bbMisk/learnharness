import React, { act, Suspense } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { parseHTML } from "linkedom";

/** DockOverlay's teach check: Enter on the folded check only reopens it, and
 *  an opened check comes back open after a reload. */
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
// linkedom has no focus model.
let focused: Element | null = null;
proto.focus = function (this: Element) { focused = this; };
proto.blur = function (this: Element) { if (focused === this) focused = null; };
Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => focused ?? dom.document.body });
Object.assign(dom.window, { location: { pathname: "/chat/p", hash: "" } });
const { createRoot, hydrateRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { StickToBottom } = await import("use-stick-to-bottom");
const { DockOverlay } = await import("../components/dock-overlay.tsx");
const { rememberRevealed } = await import("../components/revealed-questions.ts");
const { useHydrated } = await import("../components/use-hydrated.ts");
const { useReadingPosition } = await import("../components/session-navigation.tsx");

const pending = {
	key: "q1", toolCallId: "q1", tool: "quiz",
	input: { question: "Which planet is closest?", options: [{ label: "Venus" }, { label: "Mercury" }], correctAnswer: "Mercury", explanation: "x" },
};
const draft = { selection: { selected: new Set([1]), otherSelected: false, dontKnow: false }, thinking: "", other: "", text: "", confidenceIndex: 2 };

function Overlay({ onSubmit, children, reveal = true, checkEscRef, id = "q1", reading = false }: {
	onSubmit: () => void; children?: React.ReactNode; reveal?: boolean; checkEscRef?: React.RefObject<(() => void) | null>; id?: string; reading?: boolean;
}) {
	return (
		<StickToBottom>
			<StickToBottom.Content>{() => null}</StickToBottom.Content>
			<DockOverlay pending={{ ...pending, key: id, toolCallId: id } as never} initialQuestionDraft={draft} onSaveQuestionDraft={() => {}} practice={null}
				compactionRunning={false} onSubmitThinking={() => {}} teachingCheck={reveal} requiresReveal={reveal} showReadingThinking={reading}
				readingThinking="" readingThinkingRevision={0} onReadingThinking={() => {}} phase={"teach" as never} composer={null}
				onSubmitAnswer={onSubmit} footer={null} onReserve={() => {}} room="" queuedSteers={[]} checkEscRef={checkEscRef} />
			{children}
		</StickToBottom>
	);
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
	session.clear();
	focused = null;
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

it("an opened check comes back open after a reload, even if the first hydrated render is thrown away", async () => {
	// A sibling that suspends once on the post-hydration render, so React
	// discards that render and retries it.
	let thrown = false;
	function SuspendOnce() {
		const hydrated = useHydrated();
		if (hydrated && !thrown) {
			thrown = true;
			throw new Promise<void>((r) => setTimeout(r, 0));
		}
		return null;
	}
	const app = (
		<Suspense fallback={null}>
			<Overlay onSubmit={() => {}}><SuspendOnce /></Overlay>
		</Suspense>
	);
	// The server never sees session storage: it renders the folded bar.
	const html = renderToString(app);
	assert.match(html, /teach-check-reveal/);
	rememberRevealed("q1");
	const host = document.createElement("div");
	host.innerHTML = html;
	document.body.append(host);
	const errors: unknown[] = [];
	let root!: ReturnType<typeof hydrateRoot>;
	await act(async () => { root = hydrateRoot(host, app, { onRecoverableError: (e) => errors.push(e) }); });
	await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
	cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
	assert.deepEqual(errors, [], "hydrated, not client-rendered");
	assert.ok(thrown, "the post-hydration render was thrown away once");
	assert.equal(isOpen(host), true, "the check is open again");
});

async function mount(node: React.ReactNode) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
	await act(async () => root.render(node));
	return host;
}

it("clicking Open moves focus into the check; Esc folds it and drops focus out of the hidden form", async () => {
	const escRef: React.RefObject<(() => void) | null> = { current: null };
	const host = await mount(<Overlay onSubmit={() => {}} checkEscRef={escRef} id="q-focus" />);
	await act(async () => { (host.querySelector('[data-testid="teach-check-reveal"]') as HTMLElement).click(); });
	assert.equal(isOpen(host), true);
	assert.ok(document.activeElement === host.querySelector('[data-testid="question-dock"]'), "focus is in the check");
	// Typing in Your thinking, then Esc (no dictation, so it reaches Chat's layered Esc).
	(host.querySelector('[data-testid="question-dock"] [data-file-path-input]') as HTMLElement).focus();
	await act(async () => escRef.current!());
	assert.ok(host.querySelector('[data-testid="question-dock-bar"]'), "folded back to its bar");
	assert.ok(document.activeElement === document.body, "the hidden field no longer holds focus");
});

function SavePosition({ el }: { el: HTMLElement }) {
	const ref = React.useRef({ scrollRef: { current: el }, stopScroll() {} } as never);
	useReadingPosition(ref);
	return null;
}

it("coming back to a saved reading position, the question starts folded instead of covering it", async () => {
	// Leave /chat/p scrolled well above the bottom.
	const scroller = document.createElement("div");
	scroller.innerHTML = "<div data-session-find-root><div></div></div>";
	Object.defineProperty(scroller, "scrollHeight", { value: 9000 });
	Object.defineProperty(scroller, "clientHeight", { value: 800 });
	scroller.scrollTop = 0;
	const saver = createRoot(document.createElement("div"));
	await act(async () => saver.render(<SavePosition el={scroller} />));
	await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
	await act(async () => saver.unmount());
	const back = await mount(<Overlay onSubmit={() => {}} reveal={false} />);
	assert.ok(back.querySelector('[data-testid="question-dock-bar"]'), "folded over the restored passage");
	(window.location as { pathname: string }).pathname = "/chat/fresh";
	const fresh = await mount(<Overlay onSubmit={() => {}} reveal={false} />);
	assert.ok(!fresh.querySelector('[data-testid="question-dock-bar"]'), "no saved position: the question opens");
	(window.location as { pathname: string }).pathname = "/chat/p";
});

it("with no dictation running, Esc in the check's fields reaches the layered Esc instead of dying there", async () => {
	const host = await mount(<Overlay onSubmit={() => {}} id="q-esc" reading />);
	await act(async () => { (host.querySelector('[data-testid="teach-check-reveal"]') as HTMLElement).click(); });
	for (const field of [
		host.querySelector('[data-testid="reading-thinking-field"] [data-file-path-input]'),
		host.querySelector('[data-testid="question-dock"] [data-file-path-input]'),
	]) {
		assert.ok(field);
		const esc = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" });
		await act(async () => { field.dispatchEvent(esc); });
		assert.equal(esc.defaultPrevented, false, "not claimed by the field");
	}
	// Chat hands the docks a cancel only while dictation runs.
	const chat = (await import("node:fs")).readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
	assert.match(chat, /dictationCancel=\{dictation\.active \? dictation\.cancel : undefined\}/);
});

/** The transcript scroller StickToBottom attached, given a geometry. */
function scrollerOf(host: HTMLElement, scrollHeight: number, clientHeight: number) {
	const el = host.firstElementChild!.firstElementChild as HTMLElement;
	Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
	Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
	return el;
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 450)); }); // past the resize mute

async function leaveScrolled(path: string, fromBottom: number, spacer: number) {
	(window.location as { pathname: string }).pathname = path;
	const scroller = document.createElement("div");
	scroller.innerHTML = `<div data-session-find-root><div></div></div><div data-testid="dock-spacer"></div>`;
	Object.defineProperty(scroller.querySelector('[data-testid="dock-spacer"]'), "offsetHeight", { value: spacer });
	Object.defineProperty(scroller, "scrollHeight", { value: 9000 });
	Object.defineProperty(scroller, "clientHeight", { value: 800 });
	scroller.scrollTop = 9000 - 800 - fromBottom;
	const saver = createRoot(document.createElement("div"));
	await act(async () => saver.render(<SavePosition el={scroller} />));
	await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
	await act(async () => saver.unmount());
}

it("a short scroll-up (inside the dock's band) comes back with the question open, not clamped folded at the bottom", async () => {
	await leaveScrolled("/chat/short", 250, 600);
	const back = await mount(<Overlay onSubmit={() => {}} reveal={false} />);
	assert.ok(!back.querySelector('[data-testid="question-dock-bar"]'), "open: folding would shrink the page under the saved position");
	await leaveScrolled("/chat/far", 2000, 600);
	const far = await mount(<Overlay onSubmit={() => {}} reveal={false} />);
	assert.ok(far.querySelector('[data-testid="question-dock-bar"]'), "a far position still starts folded");
	(window.location as { pathname: string }).pathname = "/chat/p";
});

it("wheeling down at the bottom re-opens a folded question (no scroll event fires there)", async () => {
	await leaveScrolled("/chat/wheel", 2000, 600);
	const host = await mount(<Overlay onSubmit={() => {}} reveal={false} />);
	assert.ok(host.querySelector('[data-testid="question-dock-bar"]'));
	const el = scrollerOf(host, 2000, 800);
	el.scrollTop = 1200; // at the bottom
	await act(async () => { el.dispatchEvent(Object.assign(new dom.window.Event("wheel"), { deltaY: -40 })); });
	assert.ok(host.querySelector('[data-testid="question-dock-bar"]'), "wheeling up keeps it folded");
	await act(async () => { el.dispatchEvent(Object.assign(new dom.window.Event("wheel"), { deltaY: 40 })); });
	assert.ok(!host.querySelector('[data-testid="question-dock-bar"]'), "re-opened");
	(window.location as { pathname: string }).pathname = "/chat/p";
});

it("Esc right after Open stays folded when the reveal scroll lands at the bottom", async () => {
	const escRef: React.RefObject<(() => void) | null> = { current: null };
	const host = await mount(<Overlay onSubmit={() => {}} checkEscRef={escRef} id="q-hold" />);
	const el = scrollerOf(host, 2000, 800);
	el.scrollTop = 0;
	await settle();
	await act(async () => { (host.querySelector('[data-testid="teach-check-reveal"]') as HTMLElement).click(); });
	await act(async () => escRef.current!());
	assert.ok(host.querySelector('[data-testid="question-dock-bar"]'), "folded");
	el.scrollTop = 1200;
	await act(async () => { el.dispatchEvent(new dom.window.Event("scroll")); });
	assert.ok(host.querySelector('[data-testid="question-dock-bar"]'), "the Esc fold wins over the at-bottom re-open");
});
