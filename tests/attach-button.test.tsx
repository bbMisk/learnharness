/**
 * The composer paperclip in linkedom: on the local desktop app it offers
 * Files… / Folder…, and a picked folder attaches as its path with a trailing
 * separator (contents never read or uploaded); web and a remote-server
 * desktop window keep the plain file chooser.
 */
import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 900 });
dom.window.HTMLElement.prototype.focus = function () {};
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 800, bottom: 840, left: 20, right: 60, width: 40, height: 40, x: 20, y: 800, toJSON() {} });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	Event: dom.window.Event,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
	cancelAnimationFrame: clearTimeout,
	fetch: () => { throw new Error("No upload expected"); },
});
const { createRoot } = await import("react-dom/client");
const { useFileDrop } = await import("../components/file-drop.ts");
const { AttachButton } = await import("../components/attach-button.tsx");

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	Object.defineProperty(dom.window, "lh", { configurable: true, value: undefined });
});

let draft = "";
function Field() {
	const [value, setValue] = useState("Read this:");
	const fileDrop = useFileDrop(value, (next) => { draft = next; setValue(next); });
	return <AttachButton fileDrop={fileDrop} />;
}

async function mount(lh: unknown) {
	Object.defineProperty(dom.window, "lh", { configurable: true, value: lh });
	draft = "";
	root = createRoot(document.getElementById("root")!);
	await act(async () => root!.render(<Field />));
	const input = document.querySelector('input[type="file"]') as HTMLInputElement;
	let chooserOpened = 0;
	input.click = () => { chooserOpened++; };
	return { chooserOpened: () => chooserOpened };
}
const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
const click = (el: HTMLElement | null) => act(async () => { assert.ok(el); el.click(); });

it("desktop: the paperclip offers Files… and Folder…; a picked folder attaches by path", async () => {
	let picks = 0;
	const page = await mount({ chooseAttachmentFolder: async () => { picks++; return "/Users/me/My Notes"; } });
	await click(q("attach-button"));
	assert.ok(q("attach-menu"), "the menu opens");
	await click(q("attach-folder"));
	assert.equal(picks, 1);
	assert.equal(draft, 'Read this:\n"/Users/me/My Notes/"');
	assert.equal(q("attach-menu"), null, "the menu closes after a pick");
	await click(q("attach-button"));
	await click(q("attach-files"));
	assert.equal(page.chooserOpened(), 1);
});

it("a cancelled folder pick leaves the draft unchanged", async () => {
	await mount({ chooseAttachmentFolder: async () => null });
	await click(q("attach-button"));
	await click(q("attach-folder"));
	assert.equal(draft, "");
});

for (const [name, lh] of [["web", undefined], ["remote-server desktop", { remoteServer: true, chooseAttachmentFolder: async () => "/x" }]] as const) {
	it(`${name}: the paperclip opens the file chooser directly`, async () => {
		const page = await mount(lh);
		await click(q("attach-button"));
		assert.equal(q("attach-menu"), null);
		assert.equal(page.chooserOpened(), 1);
	});
}
