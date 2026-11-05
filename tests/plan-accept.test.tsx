/** Plan accept buttons (owner, 2026-11-05): after the plan, the learner
 *  accepts or asks for changes with two buttons, whatever the model did. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { offersPlanAccept, PlanAcceptBar, PLAN_ACCEPT_TEXT } = await import("../components/plan-accept.tsx");

const ready = { kind: "teach" as const, phase: "plan" as const, hasPlan: true, sendAllowed: true, busy: false, retryable: false };

it("offered only while a teach lesson's plan waits for the go-ahead", () => {
	assert.equal(offersPlanAccept(ready), true);
	assert.equal(offersPlanAccept({ ...ready, kind: "practice" }), false);
	for (const phase of ["probe", "teach", undefined] as const) assert.equal(offersPlanAccept({ ...ready, phase }), false, String(phase));
	assert.equal(offersPlanAccept({ ...ready, hasPlan: false }), false, "no plan on screen yet");
	assert.equal(offersPlanAccept({ ...ready, busy: true }), false, "the tutor is still writing");
	assert.equal(offersPlanAccept({ ...ready, sendAllowed: false }), false, "a question or compaction owns the input");
	assert.equal(offersPlanAccept({ ...ready, retryable: true }), false, "a failed turn waits for Retry");
});

it("Accept sends the go-ahead; Change hands over the composer", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const calls: string[] = [];
	await act(async () => root.render(<PlanAcceptBar onAccept={() => calls.push("accept")} onChange={() => calls.push("change")} />));
	const yes = host.querySelector("[data-testid=plan-accept-yes]") as HTMLButtonElement;
	const change = host.querySelector("[data-testid=plan-accept-change]") as HTMLButtonElement;
	assert.equal(yes.textContent, "Accept plan");
	assert.equal(change.textContent, "Change something");
	await act(async () => yes.click());
	await act(async () => change.click());
	assert.deepEqual(calls, ["accept", "change"]);
	assert.equal(PLAN_ACCEPT_TEXT, "The plan looks good. Teach it.");
	await act(async () => root.unmount());
});
