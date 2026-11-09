import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
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
