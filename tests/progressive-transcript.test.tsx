import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { renderToString } from "react-dom/server";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const location = { hash: "" };
Object.assign(dom.window, { location });
Object.assign(globalThis, { window: dom.window, document: dom.document, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const { TRANSCRIPT_FIRST, useProgressiveTranscript } = await import("../components/progressive-transcript.ts");

type Msg = { id: string; parts: string[] };
/** n messages of `size` parts each; part text "m<i>p<j>". */
const transcript = (n: number, size: number): Msg[] =>
	Array.from({ length: n }, (_, i) => ({ id: `m${i}`, parts: Array.from({ length: size }, (_, j) => `m${i}p${j}`) }));

let renders = 0;
function View({ messages }: { messages: Msg[] }) {
	renders++;
	const t = useProgressiveTranscript(messages);
	return (
		<div>
			{messages.map((m, mi) =>
				t.hidesMessage(mi) ? null : (
					<section key={m.id} data-message={m.id}>
						{m.parts.map((p, pi) => (t.hidesPart(mi, pi) ? null : <i key={pi}>{p}</i>))}
					</section>
				),
			)}
		</div>
	);
}

const shown = (html: string) => html.match(/m\d+p\d+/g) ?? [];
let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	location.hash = "";
});
async function mount(messages: Msg[]) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	renders = 0;
	await act(async () => root!.render(<View messages={messages} />));
	return host;
}

it("first render holds only the newest parts, across message boundaries", () => {
	const messages = transcript(10, 7); // 70 parts; one message straddles the cut
	const parts = shown(renderToString(<View messages={messages} />));
	assert.equal(parts.length, TRANSCRIPT_FIRST);
	assert.equal(parts[0], "m4p2");
	assert.equal(parts.at(-1), "m9p6");
});

it("fills in every older part after mounting", async () => {
	const messages = transcript(40, 5);
	const el = await mount(messages);
	assert.equal(shown(el.innerHTML).length, 200);
	assert.equal(shown(el.innerHTML)[0], "m0p0");
	assert.ok(renders >= 10, `filled in batches (${renders} renders)`);
});

it("never hides a message with no parts", async () => {
	const messages = [{ id: "empty", parts: [] }, ...transcript(3, 2)];
	assert.match(renderToString(<View messages={messages} />), /data-message="empty"/);
});

it("renders everything at once for a message link", async () => {
	location.hash = "#message-m0";
	const el = await mount(transcript(30, 5));
	assert.equal(shown(el.innerHTML).length, 150);
	assert.ok(renders <= 2, `one jump to the full transcript (${renders} renders)`);
});

it("keeps the newest parts visible when the list shrinks mid-fill", async () => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
	try {
		flushSync(() => root!.render(<View messages={transcript(30, 5)} />)); // fill not started
		flushSync(() => root!.render(<View messages={transcript(12, 5)} />));
		assert.deepEqual(shown(host.innerHTML), shown(renderToString(<View messages={transcript(12, 5)} />)));
		assert.equal(shown(host.innerHTML).length, TRANSCRIPT_FIRST);
	} finally {
		(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
	}
	await act(async () => {});
	assert.equal(shown(host.innerHTML).length, 60);
});
