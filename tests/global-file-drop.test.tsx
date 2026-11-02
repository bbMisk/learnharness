import React, { act, useState } from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

/** linkedom has no layout, DataTransfer or hit testing. These shims let the
 * real window-level GlobalFileDrop listeners and useFileDrop targets run. */
async function fixture({ desktop = true, fields = true } = {}) {
	const { window: win, document: doc } = parseHTML("<html><body><aside data-testid='sidebar'>Sidebar</aside><div id='root'></div></body></html>");
	let underPointer: Element[] = [];
	let laidOut = true;
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	Object.assign(doc, { elementsFromPoint: () => underPointer });
	win.HTMLElement.prototype.focus = function () { active = this; };
	win.HTMLElement.prototype.getClientRects = function () { return (laidOut ? [{}] : []) as unknown as DOMRectList; };
	const resolved: File[] = [];
	const backingPaths = new Map<File, string>();
	let byteReads = 0;
	let uploads = 0;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({
		React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		HTMLInputElement: win.HTMLInputElement, HTMLTextAreaElement: win.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true,
		getComputedStyle: () => ({ visibility: "visible", display: "block" }),
		fetch: () => { uploads++; throw new Error("No upload expected for desktop file drops"); },
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	Object.defineProperty(win, "lh", { configurable: true, value: desktop ? { getPathForFile(file: File) {
		resolved.push(file);
		return backingPaths.get(file) ?? "";
	} } : undefined });
	const { createRoot } = await import("react-dom/client");
	const { GlobalFileDrop } = await import("../components/global-file-drop.tsx");
	const { useFileDrop } = await import("../components/file-drop.ts");
	const { FileDropFeedback } = await import("../components/file-drop-feedback.tsx");
	const drafts: Record<string, string> = { message: "", thinking: "" };
	function Field({ name, priority }: { name: string; priority: number }) {
		const [value, setValue] = useState("");
		const files = useFileDrop(value, (next) => { drafts[name] = next; setValue(next); }, { priority, label: `the ${name}` });
		return <div {...files.handlers} data-testid={name}>
			<textarea data-testid={`${name}-input`} value={files.text} onChange={(event) => files.changeText(event.target.value)} />
			<FileDropFeedback files={files} />
		</div>;
	}
	const root = createRoot(doc.getElementById("root")!);
	await act(async () => root.render(<>
		<GlobalFileDrop />
		{fields && <><Field name="message" priority={10} /><Field name="thinking" priority={30} /></>}
	</>));
	cleanup = async () => {
		await act(async () => root.unmount());
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	function file(name: string, path?: string) {
		const result = new File(["synthetic bytes must never be read"], name, { type: "application/pdf" });
		for (const method of ["text", "arrayBuffer", "stream"] as const) {
			Object.defineProperty(result, method, { value: () => { byteReads++; throw new Error("No file content reads"); } });
		}
		if (path !== undefined) backingPaths.set(result, path);
		return result;
	}
	function transfer(files: File[], types = ["Files"]) {
		return { types, files, dropEffect: "none" };
	}
	async function event(type: string, dataTransfer = transfer([]), target: EventTarget = doc.querySelector('[data-testid="sidebar"]')!) {
		const event = Object.assign(new win.Event(type, { bubbles: true, cancelable: true }), { dataTransfer, clientX: 0, clientY: 0 });
		await act(async () => {
			target.dispatchEvent(event);
			// useFileDrop adds files on a promise queue; let it settle.
			for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
		});
		return event;
	}
	return {
		doc, win, drafts, resolved, file, transfer, event,
		input: (name: string) => doc.querySelector<HTMLElement>(`[data-testid="${name}-input"]`)!,
		// Focus enters the field's wrapper, which owns onFocusCapture.
		focus: async (name: string) => act(async () => { doc.querySelector(`[data-testid="${name}"]`)!.dispatchEvent(new win.Event("focusin", { bubbles: true })); }),
		pointAt: (element: Element | null) => { underPointer = element ? [element] : []; },
		setLaidOut: (next: boolean) => { laidOut = next; },
		get overlay() { return doc.querySelector('[data-testid="app-file-drop-overlay"]')?.textContent ?? null; },
		get alert() { return doc.querySelector('[role="alert"]')?.textContent ?? ""; },
		assertPathOnly() { assert.equal(byteReads, 0); assert.equal(uploads, 0); },
	};
}

test("production AppShell uses the global upload owner across the sidebar and lesson", () => {
	const source = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
	const shell = source.slice(source.indexOf("export function AppShell("));
	assert.match(shell, /<GlobalFileDrop\s*\/>/);
	assert.doesNotMatch(shell, /<FilePathDropZone/);
});

test("global file-drag shield clears on a leave without file metadata, including nested drags", async () => {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.assign(doc, { elementsFromPoint: () => [] });
	const values = { React, window: win, document: doc, IS_REACT_ACT_ENVIRONMENT: true };
	const previous = new Map(Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
	Object.assign(globalThis, values);
	const { createRoot } = await import("react-dom/client");
	const { GlobalFileDrop } = await import("../components/global-file-drop.tsx");
	const root = createRoot(doc.getElementById("root")!);
	cleanup = async () => {
		await act(async () => root.unmount());
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	await act(async () => root.render(<GlobalFileDrop />));
	const event = async (type: string, types: string[]) => act(async () => {
		win.dispatchEvent(Object.assign(new win.Event(type), { dataTransfer: { types }, clientX: 0, clientY: 0 }));
	});
	const overlay = () => doc.querySelector('[data-testid="app-file-drop-overlay"]');
	await event("dragenter", ["Files"]); assert.ok(overlay());
	await event("dragleave", []); assert.ok(!overlay(), "drop shield must be cleared");
	await event("dragenter", ["Files"]); await event("dragenter", ["Files"]);
	await event("dragleave", ["Files"]); assert.ok(overlay());
	await event("dragleave", []); assert.ok(!overlay(), "drop shield must be cleared");
	await event("dragleave", []); await event("dragenter", ["text/plain"]); assert.ok(!overlay(), "drop shield must be cleared");
});

test("desktop drop routes the full backing path to the focused field, not File.name or a higher-priority field", async () => {
	const f = await fixture();
	await f.focus("message");
	const paths = ["/actual/course notes.pdf", "C:\\course\\chapter`one.pdf"];
	const files = paths.map((path, index) => f.file(`display-name-${index}.pdf`, path));
	await f.event("dragenter", f.transfer(files));
	assert.equal(f.overlay, "Add files to the message");
	const dropped = await f.event("drop", f.transfer(files));
	assert.equal(dropped.defaultPrevented, true);
	assert.equal(f.overlay, null);
	assert.equal(f.drafts.message, paths.map((path) => JSON.stringify(path)).join("\n"));
	assert.equal(f.drafts.thinking, "", "focus wins over the higher-priority field");
	assert.deepEqual(f.resolved, files, "only Electron's full path, never File.name, enters the draft");
	assert.equal(f.doc.activeElement, f.input("message"), "the receiving field is focused after the drop");
	assert.equal(f.alert, "", "successful attachment raises no alert");
	f.assertPathOnly();
});

test("a drop directly on a field owns it; with no focus the highest-priority field receives the drop", async () => {
	const f = await fixture();
	await f.event("drop", f.transfer([f.file("a.pdf", "/existing/a.pdf")]));
	assert.equal(f.drafts.thinking, '"/existing/a.pdf"', "unfocused drop goes to the highest-priority visible field");
	assert.equal(f.drafts.message, "");
	await f.focus("thinking");
	f.pointAt(f.input("message"));
	await f.event("drop", f.transfer([f.file("b.pdf", "/existing/b.pdf")]));
	assert.equal(f.drafts.message, '"/existing/b.pdf"', "the field under the pointer wins over the focused field");
	assert.equal(f.drafts.thinking, '"/existing/a.pdf"');
	f.assertPathOnly();
});

test("a successful drop clears an earlier no-destination message; hidden fields never receive drops", async () => {
	const f = await fixture();
	f.setLaidOut(false);
	await f.event("drop", f.transfer([f.file("hidden.pdf", "/existing/hidden.pdf")]));
	assert.match(f.alert, /Open a chat or project to add files\./);
	assert.deepEqual(f.drafts, { message: "", thinking: "" });
	f.setLaidOut(true);
	await f.event("drop", f.transfer([f.file("valid.pdf", "/existing/valid.pdf")]));
	assert.equal(f.alert, "");
	assert.equal(f.drafts.thinking, '"/existing/valid.pdf"');
	f.assertPathOnly();
});

test("attached files show a removable preview; removing it deletes the path from the draft", async () => {
	const f = await fixture();
	await f.focus("message");
	await f.event("drop", f.transfer([f.file("notes.pdf", "/existing/notes.pdf")]));
	assert.equal(f.drafts.message, '"/existing/notes.pdf"');
	const remove = f.doc.querySelector<HTMLElement>('[data-testid="message"] [aria-label="Remove notes.pdf"]')!;
	assert.ok(remove, "dropped file is previewed by name");
	await act(async () => remove.click());
	assert.equal(f.drafts.message, "");
	assert.equal(f.doc.querySelector('[aria-label="Remove notes.pdf"]'), null);
	f.assertPathOnly();
});

test("file drags anywhere prevent browser navigation; non-file drags stay native", async () => {
	const f = await fixture({ fields: false });
	const plain = f.transfer([], ["text/plain"]);
	for (const type of ["dragenter", "dragover", "drop"]) {
		assert.equal((await f.event(type, plain)).defaultPrevented, false, type);
	}
	assert.equal(f.overlay, null);
	assert.equal(f.alert, "");
	const files = f.transfer([f.file("notes.pdf", "/existing/notes.pdf")]);
	const over = await f.event("dragover", files);
	assert.equal(over.defaultPrevented, true);
	assert.equal(files.dropEffect, "copy");
	assert.equal((await f.event("drop", files, f.doc.querySelector('[data-testid="sidebar"]')!)).defaultPrevented, true);
	f.assertPathOnly();
});

test("a drop with no destination says so, stages nothing and the message is dismissible", async () => {
	const f = await fixture({ fields: false });
	const dropped = await f.event("drop", f.transfer([f.file("notes.pdf", "/existing/notes.pdf")]));
	assert.equal(dropped.defaultPrevented, true);
	assert.match(f.alert, /Open a chat or project to add files\./);
	assert.deepEqual(f.resolved, [], "nothing is resolved without a destination");
	await act(async () => f.doc.querySelector<HTMLElement>('[aria-label="Dismiss file drop message"]')!.click());
	assert.equal(f.alert, "");
	await f.event("drop", f.transfer([f.file("again.pdf")]));
	assert.match(f.alert, /Open a chat or project/);
	await f.event("dragenter", f.transfer([f.file("again.pdf")]));
	assert.equal(f.overlay, "Add files to a chat");
	f.assertPathOnly();
});
