/** An old dispatch card whose job record is gone settles instead of
 * spinning "Dispatched…" forever (QA: LEC 3's PDF and demo cards). */
import React, { act } from "react";
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
const { createRoot } = await import("react-dom/client");
const { DispatchCard, DISPATCH_UNKNOWN_MS } = await import("../components/artifacts/dispatch-card.tsx");
const { JobsContext } = await import("../components/jobs-context.ts");

it("a dispatch the jobs feed never shows settles to a quiet 'Status not kept for older jobs'", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const host = dom.document.createElement("div");
	dom.document.body.append(host);
	const root = createRoot(host as unknown as HTMLElement);
	const part = { type: "tool-demo", state: "output-available", toolCallId: "call-1", output: "Dispatched." };
	try {
		await act(async () => root.render(<JobsContext.Provider value={[]}><DispatchCard part={part} /></JobsContext.Provider>));
		assert.match(host.textContent ?? "", /Dispatched…/, "fresh: the pulse while the feed catches up");
		await act(async () => mock.timers.tick(DISPATCH_UNKNOWN_MS));
		assert.ok(host.querySelector('[data-testid="dispatch-unknown"]'), "settled card");
		assert.match(host.textContent ?? "", /Status not kept for older jobs/);
		assert.ok(!host.querySelector('[role="status"]') && !/Dispatched…/.test(host.textContent ?? ""), "no spinner");
	} finally {
		await act(async () => root.unmount());
		mock.timers.reset();
	}
});

it("an old card settles as soon as a freshly loaded jobs feed lacks its job", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const host = dom.document.createElement("div");
	dom.document.body.append(host);
	const root = createRoot(host as unknown as HTMLElement);
	const part = { type: "tool-demo", state: "output-available", toolCallId: "call-old", output: "Dispatched." };
	const render = (jobs: never[]) => act(async () => root.render(<JobsContext.Provider value={jobs}><DispatchCard part={part} /></JobsContext.Provider>));
	try {
		const before: never[] = [];
		await render(before);
		await render(before);
		assert.match(host.textContent ?? "", /Dispatched…/, "same feed: still waiting");
		await render([]); // the chat's jobs fetch landed
		assert.ok(host.querySelector('[data-testid="dispatch-unknown"]'), "settled with no wait");
	} finally {
		await act(async () => root.unmount());
		mock.timers.reset();
	}
});
