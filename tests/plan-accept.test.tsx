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
const { offersPlanAccept, awaitingPlanReply, PlanAcceptBar, PLAN_ACCEPT_TEXT } = await import("../components/plan-accept.tsx");

const ready = { kind: "teach" as const, cram: false, phase: "plan" as const, hasPlan: true, awaitingReply: true, sendAllowed: true, busy: false, retryable: false };

it("offered only while a teach lesson's plan waits for the go-ahead", () => {
	assert.equal(offersPlanAccept(ready), true);
	assert.equal(offersPlanAccept({ ...ready, kind: "practice" }), false);
	for (const phase of ["probe", "teach", undefined] as const) assert.equal(offersPlanAccept({ ...ready, phase }), false, String(phase));
	assert.equal(offersPlanAccept({ ...ready, hasPlan: false }), false, "no plan on screen yet");
	assert.equal(offersPlanAccept({ ...ready, busy: true }), false, "the tutor is still writing");
	assert.equal(offersPlanAccept({ ...ready, sendAllowed: false }), false, "a question or compaction owns the input");
	assert.equal(offersPlanAccept({ ...ready, retryable: true }), false, "a failed turn waits for Retry");
	assert.equal(offersPlanAccept({ ...ready, cram: true }), false, "cram starts without approval (hunt finding)");
	assert.equal(offersPlanAccept({ ...ready, awaitingReply: false }), false, "already answered (hunt finding)");
});

it("waits for a reply only to the latest plan", () => {
	const plan = { role: "assistant", content: [{ type: "toolCall", name: "plan_init" }] };
	const prose = { role: "assistant", content: [{ type: "toolCall", name: "send_to_user" }, { type: "text", text: "Accept?" }] };
	const block = { role: "custom", content: "" };
	const learner = { role: "user", content: "accept" };
	assert.equal(awaitingPlanReply([]), false);
	assert.equal(awaitingPlanReply([plan, { role: "toolResult" }, prose, block]), true, "presented, not yet answered");
	assert.equal(awaitingPlanReply([plan, prose, learner]), false, "accepted");
	assert.equal(awaitingPlanReply([plan, prose, learner, prose]), false, "the tutor started teaching in prose and stopped");
	assert.equal(awaitingPlanReply([plan, learner, plan, prose]), true, "a revised plan waits again");
});

it("round-2 hunt findings: dock answers, failed calls, rewrites after Accept", () => {
	const plan = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", name: "plan_init", id }] });
	const planResult = (id: string, isError = false) => ({ role: "toolResult", toolName: "plan_init", toolCallId: id, isError });
	const ask = { role: "assistant", content: [{ type: "toolCall", name: "ask_user_question", id: "q" }] };
	const answer = { role: "toolResult", toolName: "ask_user_question", toolCallId: "q", isError: false };
	const accept = { role: "user", content: [{ type: "text", text: PLAN_ACCEPT_TEXT }] };
	const typed = { role: "user", content: "drop the Cantor set" };
	assert.equal(awaitingPlanReply([plan("p1"), planResult("p1"), ask, answer]), false, "answered through the question dock");
	assert.equal(awaitingPlanReply([plan("p1"), planResult("p1"), accept, plan("p2"), planResult("p2")]), false, "a rewrite after Accept doesn't ask again");
	assert.equal(awaitingPlanReply([plan("p1"), planResult("p1"), typed, plan("p2"), planResult("p2")]), true, "a revision after a change request does");
	assert.equal(awaitingPlanReply([plan("p1"), planResult("p1"), typed, plan("p2"), planResult("p2", true)]), false, "a failed revision presents nothing");
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
