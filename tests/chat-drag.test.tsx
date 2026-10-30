import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CHAT_DRAG_TYPE, startChatDrag, useChatDrop } from "../components/chat-drag.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLElement;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });
function transfer(type = CHAT_DRAG_TYPE, id = "chat_fixture") {
	const data = new Map([[type, id]]);
	return { types: [type], getData: (key: string) => data.get(key) ?? "", setData: (key: string, value: string) => data.set(key, value), effectAllowed: "none", dropEffect: "none" };
}
function Surface({ move, nested = false }: { move: (id: string) => void; nested?: boolean }) {
	const drop = useChatDrop(move);
	return <div {...drop.handlers} data-testid={nested ? "inner" : "outer"} data-over={drop.over}>
		{nested ? <button draggable onDragStart={event => startChatDrag(event, "chat_fixture")}>Chat</button> : <Surface move={id => move("inner:" + id)} nested />}
	</div>;
}
async function mount(move: (id: string) => void) {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root.render(<Surface move={move} />));
}
async function event(selector: string, type: string, data: ReturnType<typeof transfer>) {
	const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(e, "dataTransfer", { value: data });
	await act(async () => document.querySelector(selector)!.dispatchEvent(e));
	return e;
}

it("uses chat IDs for native dragging, moves once to the nearest target, and clears feedback", async () => {
	const moved: string[] = []; await mount(id => moved.push(id));
	const data = transfer();
	await event("button", "dragstart", data);
	assert.equal(data.getData(CHAT_DRAG_TYPE), "chat_fixture");
	assert.equal(data.effectAllowed, "move");
	assert.equal((await event('[data-testid="inner"]', "dragover", data)).defaultPrevented, true);
	assert.equal(data.dropEffect, "move");
	assert.equal(document.querySelector('[data-testid="inner"]')!.getAttribute("data-over"), "true");
	await event('[data-testid="inner"]', "drop", data);
	assert.deepEqual(moved, ["inner:chat_fixture"]);
	assert.equal(document.querySelector('[data-testid="inner"]')!.getAttribute("data-over"), "false");
	await event('[data-testid="outer"]', "dragover", data);
	await event("button", "dragend", data);
	assert.equal(document.querySelector('[data-testid="outer"]')!.getAttribute("data-over"), "false");
});

it("leaves file drops to the upload handler and never forwards invalid chat IDs", async () => {
	const moved: string[] = []; await mount(id => moved.push(id));
	for (const type of ["Files", "text/plain"]) {
		const data = transfer(type);
		assert.equal((await event('[data-testid="inner"]', "dragover", data)).defaultPrevented, false);
		assert.equal((await event('[data-testid="inner"]', "drop", data)).defaultPrevented, false);
	}
	await event('[data-testid="inner"]', "drop", transfer(CHAT_DRAG_TYPE, "../outside"));
	assert.deepEqual(moved, []);
});
