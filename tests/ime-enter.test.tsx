import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";

// The Enter that confirms a Japanese or Chinese input-method candidate
// (keyCode 229, isComposing) belongs to the IME: no field commits on it.
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.assign(dom.window.HTMLElement.prototype, { select() {}, scrollIntoView() {} });
// React listens for input events only when the document advertises oninput.
Object.assign(dom.document, { oninput: null });
const { createRoot } = await import("react-dom/client");
const { InlineRename } = await import("../components/inline-rename.tsx");
const { RenameRow } = await import("../components/sidebar.tsx");
const { EditableSourceName } = await import("../components/source-folder-tree.tsx");
const { CommitInput } = await import("../components/settings/controls.tsx");
const { SearchMenuList } = await import("../components/settings/search-menu-list.tsx");
const { useSessionRename } = await import("../components/session-rename.ts");
const { isComposing } = await import("../components/ime.ts");

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
	await act(async () => { root?.unmount(); });
	host?.remove();
	root = null;
	host = null;
});
async function render(node: React.ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => { root!.render(node); });
	return host;
}
async function enter(el: Element, composing: boolean) {
	const event = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), {
		key: "Enter", isComposing: composing, keyCode: composing ? 229 : 13,
	});
	await act(async () => {
		el.dispatchEvent(event);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return event;
}

it("isComposing reads both the flag and keyCode 229", () => {
	assert.equal(isComposing({ isComposing: true, keyCode: 13 } as KeyboardEvent), true);
	assert.equal(isComposing({ isComposing: false, keyCode: 229 } as KeyboardEvent), true);
	assert.equal(isComposing({ isComposing: false, keyCode: 13 } as KeyboardEvent), false);
});

it("the project rename keeps editing on the IME's Enter", async () => {
	const commits: string[] = [];
	const el = await render(<InlineRename value="Quant" ariaLabel="Name" onCommit={async (n) => void commits.push(n)} onDone={() => {}} />);
	const input = el.querySelector("input")!;
	input.value = "Quant かな";
	await enter(input, true);
	assert.deepEqual(commits, []);
	await enter(input, false);
	assert.deepEqual(commits, ["Quant かな"]);
});

it("the sidebar chat rename keeps editing on the IME's Enter", async () => {
	const chat = { id: "c1", title: "Old", kind: "teach", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" };
	const el = await render(<RenameRow chat={chat as never} onCommit={() => {}} onCancel={() => {}} />);
	const input = el.querySelector("input")!;
	let blurs = 0;
	input.blur = () => { blurs++; };
	await enter(input, true);
	assert.equal(blurs, 0);
	await enter(input, false);
	assert.equal(blurs, 1);
});

it("the chain-table source rename keeps editing on the IME's Enter", async () => {
	const saved: string[] = [];
	const el = await render(<EditableSourceName name="LEC 4" initiallyEditing onSave={async (n) => void saved.push(n)} />);
	const input = el.querySelector("input")!;
	await enter(input, true);
	assert.deepEqual(saved, []);
	assert.ok(el.querySelector("input"), "still editing");
});

it("a Settings text field keeps editing on the IME's Enter", async () => {
	const commits: string[] = [];
	const el = await render(<CommitInput value="a" ariaLabel="name" testid="input" onCommit={(v) => void commits.push(v)} />);
	const input = el.querySelector("input")!;
	input.setAttribute("type", "text"); // linkedom reports no type, so React would skip onChange
	Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "かな");
	await act(async () => { input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
	await enter(input, true);
	assert.deepEqual(commits, []);
	await enter(input, false);
	assert.deepEqual(commits, ["かな"]);
});

it("a search menu (dictation language, provider) doesn't pick on the IME's Enter", async () => {
	const picked: string[] = [];
	const el = await render(
		<SearchMenuList items={["ja", "zh"]} itemKey={(i) => i} searchTerms={(i) => [i]} isSelected={() => false}
			onPick={(i) => void picked.push(i)} renderItem={(i) => i} searchTestid="s" listTestid="l" optionTestid={(i) => i}
			placeholder="Search" empty="None" />,
	);
	const input = el.querySelector("input")!;
	const composing = await enter(input, true);
	assert.deepEqual(picked, []);
	assert.equal(composing.defaultPrevented, false);
	await enter(input, false);
	assert.deepEqual(picked, ["ja"]);
});

it("the header rename's IME Enter doesn't commit, and the IME keeps its Enter", async () => {
	const puts: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (_url: string, init?: RequestInit) => { puts.push(String(init?.body)); return Response.json({ ok: true }); }) as typeof fetch;
	function Title() {
		// The header's own onKeyDown (components/chat.tsx).
		const { titleText, renaming, titleDraft, titleInputRef, commitRename } = useSessionRename("c1", "Old");
		return renaming ? (
			<input ref={titleInputRef} value={titleDraft} readOnly
				onKeyDown={(e) => { if (e.key === "Enter" && !isComposing(e)) void commitRename("New かな"); }} />
		) : <span>{titleText}</span>;
	}
	try {
		const el = await render(<Title />);
		await act(async () => { window.dispatchEvent(new dom.window.CustomEvent("lh:kbd-rename-session")); });
		const input = el.querySelector("input")!;
		const composing = await enter(input, true);
		assert.ok(el.querySelector("input"), "still editing");
		assert.equal(composing.defaultPrevented, false, "the IME keeps its Enter");
		assert.deepEqual(puts, []);
		await enter(input, false);
		assert.equal(el.querySelector("input"), null);
		assert.equal(puts.length, 1);
	} finally {
		globalThis.fetch = realFetch;
	}
});

it("the fields not rendered here guard their Enter too (source pin)", async () => {
	const { readFileSync } = await import("node:fs");
	const pins: Record<string, RegExp> = {
		"components/chat.tsx": /if \(e\.key === "Enter" && !isComposing\(e\)\) void commitRename\(titleDraft\)/,
		"components/sidebar.tsx": /if \(e\.key === "Enter" && !isComposing\(e\)\) \{\n\s*const target = shown!/,
		"components/settings/model-menu.tsx": /e\.key === "Enter" && !isComposing\(e\)\) \{\n\s*const chosen = walkable/,
		"components/settings/agent-section.tsx": /event\.key === "Enter" && !isComposing\(event\)\) \{ event\.preventDefault\(\); addFolder\(\);/,
		"components/dictation-language.tsx": /HTMLInputElement && !isComposing\(event\)\) event\.preventDefault\(\)/,
	};
	for (const [file, pin] of Object.entries(pins)) assert.match(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), pin, file);
});
