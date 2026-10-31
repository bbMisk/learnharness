import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { FlashcardAgentSection } = await import("../components/settings/flashcard-agent-section.tsx");
const { useReadingThinkingRefresh } = await import("../components/reading-thinking-refresh.ts");
const { notifySettingsSaved } = await import("../components/settings-signal.ts");

let root: Root;
let host: HTMLElement;
const realFetch = globalThis.fetch;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	globalThis.fetch = realFetch;
});
async function render(element: React.ReactElement) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root.render(element));
	await settle();
}
const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
const alerts = () => [...host.querySelectorAll('[role="alert"]')].map((node) => ({ text: node.textContent, className: node.className }));

const status = { running: false, phase: "Idle", preparedToday: 3, startedToday: 3, dailyLimit: 20, error: null, model: null, projects: [] };

it("flashcard settings show a failed status load and clear it on the next success", async () => {
	let statusOk = false;
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "POST") return new Response("{}", { status: 200 });
		return statusOk ? new Response(JSON.stringify(status), { status: 200 }) : new Response("{}", { status: 503 });
	}) as typeof fetch;
	await render(<FlashcardAgentSection agent={undefined} onChange={() => {}} />);
	assert.deepEqual(alerts(), [{ text: "Could not load preparation status.", className: "text-xs text-destructive" }]);

	statusOk = true;
	const prepare = [...host.querySelectorAll("button")].find((button) => button.textContent === "Prepare now")!;
	await act(async () => prepare.click());
	await settle();
	assert.deepEqual(alerts(), []);
	assert.match(host.textContent ?? "", /3 prepared today/);
});

it("a failed settings refresh after a save shows a message until the next successful read", async () => {
	let ok = false;
	const applied: boolean[] = [];
	globalThis.fetch = (async () =>
		ok
			? new Response(JSON.stringify({ settings: { version: 1, general: { showReadingThinking: false } } }), { status: 200 })
			: new Response("{}", { status: 500 })) as typeof fetch;
	function Harness() {
		const error = useReadingThinkingRefresh((show) => applied.push(show));
		return error ? (
			<p role="alert" className="text-xs text-destructive">
				{error}
			</p>
		) : null;
	}
	await render(<Harness />);
	assert.deepEqual(alerts(), []);

	await act(async () => notifySettingsSaved("general"));
	await settle();
	assert.deepEqual(
		alerts().map((alert) => alert.text),
		["Could not load your updated settings. Reload to apply them."],
	);
	assert.deepEqual(applied, []);

	ok = true;
	await act(async () => notifySettingsSaved("models"));
	await settle();
	assert.deepEqual(alerts(), []);
	assert.deepEqual(applied, [false]);
});
