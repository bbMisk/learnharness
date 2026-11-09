/** Switching away from a chat and back returns to the reading position
 * (QA: scrollTop 20000 came back as the bottom, 58163). */
import React, { act, useRef } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it, mock } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});
Object.assign(dom.window, { location: { pathname: "/chat/a", hash: "" } });
const { createRoot } = await import("react-dom/client");
const { useReadingPosition } = await import("../components/session-navigation.tsx");

const VIEW = 800;
const ROW = 100;

/** A transcript scroller with `rows` 100px rows and a `tail`px dock spacer
 *  below them, opened at its bottom (stick-to-bottom). */
function transcript(rows: number, tail = 0) {
	const scroller = dom.document.createElement("div") as unknown as HTMLElement & { rows: number; tail: number };
	Object.assign(scroller, { rows, tail });
	const root = dom.document.createElement("div");
	root.setAttribute("data-session-find-root", "");
	scroller.append(root);
	const layout = () => {
		while (root.children.length < scroller.rows) root.prepend(dom.document.createElement("div"));
		[...root.children].forEach((row, i) => {
			(row as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () =>
				({ top: i * ROW - scroller.scrollTop, bottom: (i + 1) * ROW - scroller.scrollTop });
		});
	};
	Object.defineProperty(scroller, "clientHeight", { value: VIEW });
	Object.defineProperty(scroller, "scrollHeight", { get: () => scroller.rows * ROW + scroller.tail });
	scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
	const grow = (n: number) => { scroller.rows = n; layout(); };
	layout();
	scroller.scrollTop = scroller.scrollHeight - VIEW;
	return { scroller, grow };
}

function Probe({ el, stopped }: { el: HTMLElement; stopped: { n: number } }) {
	const contextRef = useRef({ scrollRef: { current: el }, stopScroll: () => void stopped.n++ } as never);
	useReadingPosition(contextRef);
	return null;
}

async function open(el: HTMLElement, path: string) {
	(dom.window.location as { pathname: string }).pathname = path;
	const stopped = { n: 0 };
	const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
	await act(async () => root.render(<Probe el={el} stopped={stopped} />));
	await act(async () => mock.timers.tick(100));
	return { close: () => act(async () => root.unmount()), stopped };
}

const scrolled = (el: HTMLElement, top: number) => {
	el.scrollTop = top;
	el.dispatchEvent(new dom.window.Event("scroll"));
};

it("returns to the reading position after a chat switch; the bottom stays the bottom", async () => {
	mock.timers.enable({ apis: ["setInterval", "Date"] });
	try {
		// Read mid-history in chat A (row 200 of 600, 30px into it), switch to B.
		let a = transcript(600, 300);
		let view = await open(a.scroller, "/chat/a");
		scrolled(a.scroller, 20_030);
		await view.close();
		const b = await open(transcript(50).scroller, "/chat/b");
		await b.close();
		// Back to A: newest rows first, older history fills in above, and the
		// dock's spacer is a different height this time.
		a = transcript(40, 120);
		view = await open(a.scroller, "/chat/a");
		assert.equal(a.scroller.scrollTop, 40 * ROW + 120 - VIEW, "that row isn't rendered yet: stays at the bottom");
		a.grow(600);
		await act(async () => mock.timers.tick(100));
		assert.equal(a.scroller.scrollTop, 20_030, "back on the same row, at the same offset");
		assert.ok(view.stopped.n > 0, "the bottom-follow lock is released first");
		await act(async () => mock.timers.tick(5_000));
		await view.close();
		// A chat left at its bottom reopens at its bottom.
		const c = transcript(600);
		view = await open(c.scroller, "/chat/c");
		scrolled(c.scroller, c.scroller.scrollHeight - VIEW - 10);
		await view.close();
		const again = transcript(600);
		view = await open(again.scroller, "/chat/c");
		await act(async () => mock.timers.tick(1_000));
		assert.equal(again.scroller.scrollTop, 600 * ROW - VIEW);
		assert.equal(view.stopped.n, 0);
		await view.close();
	} finally {
		mock.timers.reset();
	}
});
