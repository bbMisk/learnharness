import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { renderToString } from "react-dom/server";
import { createRoot, hydrateRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";

/** A saved draft lives in browser storage the server can't read. Hydrating
 *  the server's HTML must not throw a mismatch (React #418); the draft shows
 *  right after hydration instead. */
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const storage = new Map<string, string>();
Object.defineProperty(dom.window, "localStorage", { configurable: true, value: {
	getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); },
	removeItem: (k: string) => { storage.delete(k); }, key: (i: number) => [...storage.keys()][i] ?? null, get length() { return storage.size; },
} });

async function hydrate(server: React.ReactElement, client: React.ReactElement): Promise<{ host: HTMLElement; errors: unknown[]; unmount: () => Promise<void> }> {
	const host = document.createElement("div");
	host.innerHTML = renderToString(server);
	document.body.append(host);
	const errors: unknown[] = [];
	let root!: ReturnType<typeof hydrateRoot>;
	await act(async () => { root = hydrateRoot(host, client, { onRecoverableError: (e) => errors.push(e) }); });
	return { host, errors, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

const input = { question: "Pick one", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], correctAnswer: "yes", explanation: "Yes." };

test("a question draft restores after hydration without a mismatch", async () => {
	const dock = (draft?: { thinking: string }) => (
		<QuestionDock toolName="quiz" toolCallId="q1" input={input as never} expanded onExpand={() => {}} onSubmit={() => {}} dictationClaim={false}
			initialDraft={draft as never} onSaveDraft={() => {}} />
	);
	const { host, errors, unmount } = await hydrate(dock(), dock({ thinking: "my saved thinking" }));
	try {
		assert.deepEqual(errors, []);
		assert.match(host.innerHTML, /my saved thinking/);
	} finally { await unmount(); }
});

test("a practice draft restores after hydration without a mismatch", async () => {
	const dock = (key: string) => <PracticeDock key={key} problemCallId="p1" input={{ statement: "Prove it." }} expanded onExpand={() => {}} onSubmit={() => {}} />;
	// The server has no storage; the browser has the saved draft.
	const server = renderToString(dock("p1"));
	storage.set("lh:draft:p:p1", JSON.stringify("practice thinking"));
	const host = document.createElement("div");
	host.innerHTML = server;
	document.body.append(host);
	const errors: unknown[] = [];
	let root!: ReturnType<typeof hydrateRoot>;
	// DockOverlay remounts the practice dock once hydrated (its key changes).
	function Remount() {
		const [hydrated, setHydrated] = React.useState(false);
		React.useEffect(() => setHydrated(true), []);
		return dock(hydrated ? "p1" : "p1:server");
	}
	try {
		await act(async () => { root = hydrateRoot(host, <Remount />, { onRecoverableError: (e) => errors.push(e) }); });
		assert.deepEqual(errors, []);
		assert.match(host.innerHTML, /practice thinking/);
	} finally {
		await act(async () => root.unmount());
		host.remove();
		storage.clear();
	}
});

// A remount on the client (a chat switch, or the post-hydration remount)
// restores the whole saved form.
describe("question submission draft restoration", () => {
	const quizInput = {
		question: "Which planet is closest to the sun?",
		options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
		correctAnswer: "Mercury",
		explanation: "Mercury is the innermost planet.",
	};
	const draft = {
		selection: { selected: new Set([0]), otherSelected: true, dontKnow: false },
		thinking: "preserved reasoning",
		other: "preserved custom answer",
		text: "preserved free-text answer",
		confidenceIndex: 4,
	};
	const render = async (element: React.ReactElement) => {
		const host = document.createElement("div");
		const root = createRoot(host);
		await act(async () => root.render(element));
		const html = host.innerHTML;
		const checked = (selector: string) => host.querySelector(selector)?.getAttribute("aria-checked");
		const state = { html, first: checked('[role="radio"][data-kbdrow="0"]'), other: checked('[data-testid="other-option"]') };
		await act(async () => root.unmount());
		return state;
	};

	it("restores a quiz selection, thinking, and confidence when its form remounts", async () => {
		const { html, first } = await render(<QuestionDock toolName="quiz" toolCallId="q1" input={quizInput as never} expanded onExpand={() => {}} onSubmit={() => {}} initialDraft={draft} />);
		assert.equal(first, "true");
		assert.ok(html.includes("preserved reasoning"));
		assert.ok(html.includes("90%"));
	});

	it("restores an ask's custom answer and a free-text answer", async () => {
		const { html: custom, other } = await render(<QuestionDock toolName="ask_user_question" toolCallId="ask1" input={{ question: "Fixture?", options: [{ label: "Listed answer" }, { label: "Another answer" }], multiSelect: true } as never} expanded onExpand={() => {}} onSubmit={() => {}} initialDraft={draft} />);
		assert.match(custom, /role="textbox"[^>]*>preserved custom answer<\/div>/);
		assert.equal(other, "true");
		const { html: text } = await render(<QuestionDock toolName="ask_user_question" toolCallId="ask2" input={{ question: "Fixture?" } as never} expanded onExpand={() => {}} onSubmit={() => {}} initialDraft={draft} />);
		assert.ok(text.includes("preserved free-text answer"));
	});
});
