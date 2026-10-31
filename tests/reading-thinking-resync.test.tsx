import React, { act, useRef, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useReadingThinkingResync, type ReadingThinkingSeed } from "../components/reading-thinking-resync.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let api: { seed: ReadingThinkingSeed; type: (v: string) => void; show: (v: boolean) => void };
afterEach(async () => {
	await act(async () => root?.unmount());
});

function Harness() {
	const [visible, setVisible] = useState(true);
	const [seed, setSeed] = useState<ReadingThinkingSeed>({ questionId: "q1", value: "", revision: 0 });
	const draft = useRef("");
	useReadingThinkingResync(visible, draft, setSeed);
	api = { seed, type: (v) => (draft.current = v), show: setVisible };
	return null;
}

it("a field shown again starts from what was typed, not the opening seed", async () => {
	root = createRoot(document.createElement("div"));
	await act(async () => root!.render(<Harness />));
	const opened = api.seed.revision;
	api.type("notes typed while reading");
	await act(async () => api.show(false));
	await act(async () => api.show(true));
	assert.equal(api.seed.value, "notes typed while reading");
	assert.ok(api.seed.revision > opened, "the remounted field is told to reload");
});

it("leaves the seed alone when nothing changed", async () => {
	root = createRoot(document.createElement("div"));
	await act(async () => root!.render(<Harness />));
	const before = api.seed;
	await act(async () => api.show(false));
	await act(async () => api.show(true));
	assert.ok(api.seed === before);
});
