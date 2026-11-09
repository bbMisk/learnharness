import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

// One Esc, one layer; focus restores verify themselves; a failed click-away
// rename never takes focus back; a rejected key keeps it; IME Esc is the IME's.

const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Node: dom.window.Node,
	CustomEvent: dom.window.CustomEvent, Event: dom.window.Event, MutationObserver: dom.window.MutationObserver,
	CSS: { highlights: new Map() }, IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: { getItem: () => null, setItem() {} },
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window, {
	innerWidth: 1280, innerHeight: 800,
	getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", whiteSpace: "normal", getPropertyValue: () => "" }),
	getSelection: () => ({ toString: () => "" }),
});
Object.assign(dom.document, { oninput: null });
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
	if (!this.isContentEditable) range = null; // a plain field takes the selection
	else if (!(range && this.contains(range.startContainer))) range = at(this, 0);
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

/** A lesson text field (`testid` wraps it) holding "hello world". */
function field(testid: string): HTMLElement {
	const wrap = document.createElement("div");
	wrap.setAttribute("data-testid", testid);
	const el = document.createElement("div");
	el.setAttribute("data-file-path-input", "");
	el.textContent = "hello world";
	Object.defineProperty(el, "isContentEditable", { value: true });
	wrap.append(el);
	document.body.append(wrap);
	hosts.push(wrap);
	return el;
}
/** The learner was typing in `el` with the caret after "hello wo". */
function typingMidText(el: HTMLElement) {
	range = at(el.firstChild!, 8);
	el.focus();
}
const caretMidText = (el: HTMLElement) => focused === el && range?.startContainer === el.firstChild && range.startOffset === 8;
const caretAtEnd = (el: HTMLElement) => focused === el && range?.endContainer === el && range.startOffset === el.childNodes.length;
function mountHost(): HTMLElement {
	const host = document.createElement("div");
	document.body.append(host);
	hosts.push(host);
	root = createRoot(host);
	return host;
}
async function escape(target: EventTarget = document) {
	await act(async () => { target.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" })); });
}
const frame = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
const key = (k: string, extra: Record<string, unknown> = {}) =>
	Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: k, ...extra });
const findOpen = () => !!document.querySelector('[data-testid="session-find"]');
async function mountFind(extra: React.ReactNode = null) {
	const { SessionFind } = await import("../components/session-find.tsx");
	const { kbdEventForAction } = await import("../src/core/keyboard.ts");
	const scope = document.createElement("div");
	hosts.push(scope);
	mountHost();
	await act(async () => { root!.render(<><SessionFind scopeRef={{ current: scope as HTMLDivElement }} scrollContextRef={{ current: null }} />{extra}</>); });
	await act(async () => { window.dispatchEvent(new dom.window.Event(kbdEventForAction("find"))); });
	assert.ok(findOpen(), "Find opened");
}

it("Esc in a sidebar rename under an open Find discards the rename only", async () => {
	const { RenameRow } = await import("../components/sidebar.tsx");
	let cancelled = 0;
	const chat = { id: "c1", title: "LEC 3", updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() } as never;
	await mountFind(<RenameRow chat={chat} onCommit={() => {}} onCancel={() => { cancelled++; }} />);
	const input = document.querySelector<HTMLInputElement>('[data-testid="session-rename-input"]')!;
	const event = key("Escape");
	await act(async () => { input.dispatchEvent(event); });
	assert.equal(cancelled, 1, "the rename is discarded");
	assert.ok(event.defaultPrevented, "the rename claims its Esc");
	assert.ok(findOpen(), "Find stays open");
	await escape();
	assert.ok(!findOpen(), "the next Esc closes Find");
});

it("a field that claims Esc (the side tutor, the sidebar search) leaves Find open", async () => {
	await mountFind(<input data-testid="claimer" onKeyDown={(e) => { if (e.key === "Escape") e.preventDefault(); }} />);
	await act(async () => { document.querySelector('[data-testid="claimer"]')!.dispatchEvent(key("Escape")); });
	assert.ok(findOpen());
});

it("a restore whose target can't take focus reports failure, so the fallback runs", async () => {
	const { captureFocus } = await import("../components/focus-return.ts");
	const hidden = field("thinking-field");
	typingMidText(hidden);
	const restore = captureFocus()!;
	focused = null;
	Object.assign(hidden, { checkVisibility: () => false }); // the check folded
	assert.equal(restore(true), false, "hidden: not restored");
	const refusing = field("composer");
	typingMidText(refusing);
	const restore2 = captureFocus()!;
	focused = null;
	Object.assign(refusing, { focus() {} }); // disabled or inert: focus() doesn't land
	assert.equal(restore2(true), false, "focus didn't land: not restored");
});

it("Find closes into the visible field when the one it came from folded", async () => {
	const thinking = field("thinking-field");
	const reading = field("reading-thinking-field");
	typingMidText(thinking);
	await mountFind();
	// Find's Enter step scrolled to a match and the check folded.
	Object.assign(thinking, { checkVisibility: () => false });
	await escape();
	assert.ok(!findOpen());
	assert.ok(caretAtEnd(reading), "the visible reading note, not <body>");
});

const { useSessionRename } = await import("../components/session-rename.ts");
function RenameHarness() {
	const r = useSessionRename("c1", "Old");
	return <>
		<button data-testid="title" onClick={() => { r.setTitleDraft("New"); r.setRenaming(true); }} />
		{r.renaming && <input ref={r.titleInputRef} data-testid="title-input" value={r.titleDraft}
			onChange={(e) => r.setTitleDraft(e.target.value)}
			onKeyDown={(e) => { if (e.key === "Enter") void r.commitRename(r.titleDraft); }}
			onBlur={() => void r.commitRename(r.titleDraft)} />}
		<p data-testid="err">{r.renameError}</p>
		<input data-testid="elsewhere" />
	</>;
}

it("a failed click-away rename keeps the text and error but not focus; Enter keeps focus", async () => {
	let puts = 0;
	globalThis.fetch = (async () => { puts++; return { ok: false, status: 500 }; }) as unknown as typeof fetch;
	const host = mountHost();
	await act(async () => { root!.render(<RenameHarness />); });
	const q = (id: string) => host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
	await act(async () => { q("title").click(); });
	assert.equal(focused, q("title-input"), "opening focuses the field");
	// Click away: focus moves on, then the field blurs.
	q("elsewhere").focus();
	await act(async () => { q("title-input").dispatchEvent(new dom.window.Event("focusout", { bubbles: true })); });
	await frame();
	assert.equal(puts, 1);
	assert.ok(q("title-input"), "the field reopened");
	assert.equal(q("err").textContent, "Chat could not be renamed. Try again.");
	assert.equal(focused, q("elsewhere"), "focus stays where the user went");
	// Enter in the reopened field: a failure keeps editing there.
	q("title-input").focus();
	await act(async () => { q("title-input").dispatchEvent(key("Enter")); });
	await frame();
	assert.equal(puts, 2);
	assert.equal(focused, q("title-input"), "Enter's failure keeps the field focused");
});

it("the sidebar rename row: Enter or a click away tells the commit which, and a quiet reopen takes no focus", async () => {
	const { RenameRow } = await import("../components/sidebar.tsx");
	const commits: boolean[] = [];
	const chat = { id: "c1", title: "LEC 3", updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() } as never;
	const host = mountHost();
	await act(async () => { root!.render(<RenameRow chat={chat} takeFocus={false} onCommit={(_, byKey) => { commits.push(byKey); }} onCancel={() => {}} />); });
	const input = host.querySelector<HTMLInputElement>('[data-testid="session-rename-input"]')!;
	assert.notEqual(focused, input, "a quiet reopen leaves focus alone");
	await act(async () => { input.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })); });
	await act(async () => { input.dispatchEvent(key("Enter")); input.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })); });
	assert.deepEqual(commits, [false, true]);
});

it("an Esc that cancels an IME composition doesn't close a Settings menu", async () => {
	const { bindSettingsMenuDismiss } = await import("../components/settings/controls.tsx");
	let closed = 0;
	const unbind = bindSettingsMenuDismiss({ current: document.body }, () => { closed++; });
	document.dispatchEvent(key("Escape", { isComposing: true, keyCode: 229 }));
	assert.equal(closed, 0, "the IME's Esc");
	const claimed = key("Escape");
	claimed.preventDefault();
	document.dispatchEvent(claimed);
	assert.equal(closed, 0, "a layer above already claimed it");
	document.dispatchEvent(key("Escape"));
	assert.equal(closed, 1);
	unbind();
});

it("a rejected setup key gives focus back to the key field", async () => {
	const { SetupKeysBody } = await import("../components/setup-dialog.tsx");
	const provider = { id: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY" } as never;
	const props = { providers: [provider], provider, value: "not a key", menuOpen: false, onToggleMenu() {}, onPick() {}, onValue() {}, onSave() {}, menuAnchor: { current: null } };
	const host = mountHost();
	await act(async () => { root!.render(<SetupKeysBody {...props} saving error={null} />); });
	focused = null; // the disabled field dropped focus
	await act(async () => { root!.render(<SetupKeysBody {...props} saving={false} error="A key can't contain spaces or line breaks" />); });
	assert.equal(focused, host.querySelector('[data-testid="setup-key-input"]'));
});

it("the Chains source rename is marked as a rename, so F keys leave it alone", async () => {
	const { EditableSourceName } = await import("../components/source-folder-tree.tsx");
	const host = mountHost();
	await act(async () => { root!.render(<EditableSourceName name="LEC 4" onSave={async () => {}} initiallyEditing />); });
	assert.ok(host.querySelector('[data-testid="source-name-input"]')?.hasAttribute("data-lh-rename"));
});

it("the offline strip and update band sit below the dialog tier (z-50)", async () => {
	const { readFileSync } = await import("node:fs");
	for (const file of ["components/offline-notice.tsx", "components/update-banner.tsx", "components/deploy-reload.tsx"]) {
		const source = readFileSync(new URL("../" + file, import.meta.url), "utf8");
		assert.match(source, /fixed [^"]*z-\[45\]/, file);
		assert.doesNotMatch(source, /fixed [^"]*z-50/, file);
	}
});

it("Esc out of the empty graph node search hands focus back", async () => {
	const { GraphChromeRow } = await import("../components/graph-view.tsx");
	const { DEFAULT_RENDER_SETTINGS } = await import("../src/core/render-settings.ts");
	let left = 0;
	const host = mountHost();
	await act(async () => {
		root!.render(<GraphChromeRow isEmpty={false} query="" onQuery={() => {}} noMatch={false} importing={false}
			searchInputRef={{ current: null }} onImportFiles={() => {}} settings={DEFAULT_RENDER_SETTINGS as never}
			changeSettings={() => {}} onOpenChains={() => {}} onFit={() => {}} onLeaveSearch={() => { left++; }} />);
	});
	await escape(host.querySelector('input[aria-label="Search nodes"]')!);
	assert.equal(left, 1);
});
