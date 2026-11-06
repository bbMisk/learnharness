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
	assert.equal(offersPlanAccept({ ...ready, cram: true }), false, "cram starts without approval");
	assert.equal(offersPlanAccept({ ...ready, awaitingReply: false }), false, "already answered");
});

it("waits for a reply only to the latest plan", () => {
	const planCall = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", name: "plan_init", id }] });
	const ok = (id: string) => ({ role: "toolResult", toolName: "plan_init", toolCallId: id, isError: false, details: { ok: true, tree: { nodes: [], edges: [] } } });
	const prose = { role: "assistant", content: [{ type: "toolCall", name: "send_to_user" }, { type: "text", text: "Accept?" }] };
	const block = { role: "custom", content: "" };
	const learner = { role: "user", content: "accept" };
	assert.equal(awaitingPlanReply([]), false);
	assert.equal(awaitingPlanReply([planCall("a"), ok("a"), prose, block]), true, "presented, not yet answered");
	assert.equal(awaitingPlanReply([planCall("a"), ok("a"), prose, learner]), false, "accepted");
	assert.equal(awaitingPlanReply([planCall("a"), ok("a"), prose, learner, prose]), false, "the tutor started teaching in prose and stopped");
	assert.equal(awaitingPlanReply([planCall("a"), ok("a"), learner, planCall("b"), ok("b"), prose]), true, "a revised plan waits again");
});

it("dock answers, failed calls, rewrites after Accept", () => {
	const plan = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", name: "plan_init", id }] });
	const planResult = (id: string, isError = false) => ({ role: "toolResult", toolName: "plan_init", toolCallId: id, isError, details: isError ? null : { ok: true, tree: { nodes: [], edges: [] } } });
	const ask = { role: "assistant", content: [{ type: "toolCall", name: "ask_user_question", id: "q" }] };
	const answer = { role: "toolResult", toolName: "ask_user_question", toolCallId: "q", isError: false, details: { kind: "ask", answers: [{ index: 1, label: "Accept the plan" }] } };
	const accept = { role: "user", content: [{ type: "text", text: PLAN_ACCEPT_TEXT }] };
	const typed = { role: "user", content: "drop the Cantor set" };
	assert.equal(awaitingPlanReply([plan("p1"), planResult("p1"), ask, answer]), false, "answered through the question dock");
	assert.equal(awaitingPlanReply([plan("p1"), planResult("p1"), accept, plan("p2"), planResult("p2")]), true, "a rewrite after Accept asks again (accepting twice is harmless)");
	assert.equal(awaitingPlanReply([plan("p1"), planResult("p1"), typed, plan("p2"), planResult("p2")]), true, "a revision after a change request does");
	assert.equal(awaitingPlanReply([plan("p1"), planResult("p1"), typed, plan("p2"), planResult("p2", true)]), false, "a failed revision presents nothing");
	assert.equal(awaitingPlanReply([plan("p1"), planResult("p1"), accept, typed, plan("p2"), planResult("p2")]), true, "a change request after Accept gets its revision offered");
	const failedAsk = { role: "toolResult", toolName: "ask_user_question", toolCallId: "q", isError: true };
	assert.equal(awaitingPlanReply([plan("p1"), planResult("p1"), ask, failedAsk]), true, "a failed question is not a reply");
	const dismissed = { role: "toolResult", toolName: "ask_user_question", toolCallId: "q", isError: false, details: { kind: "ask", dismissed: true } };
	assert.equal(awaitingPlanReply([plan("p1"), planResult("p1"), ask, dismissed]), true, "a dismissed question is not a reply");
	const placeholder = { role: "toolResult", toolName: "ask_user_question", toolCallId: "q", isError: false, details: null };
	assert.equal(awaitingPlanReply([plan("p1"), planResult("p1"), ask, placeholder]), true, "a streamed placeholder is not a reply");
	assert.equal(awaitingPlanReply([plan("p1"), planResult("p1"), ask, placeholder, dismissed]), true, "placeholder then dismissal: still awaiting");
	assert.equal(awaitingPlanReply([plan("p1"), planResult("p1"), accept, ask, answer, plan("p2"), planResult("p2")]), true, "a dock answer after Accept can ask for changes");
	// An invalid map returns { ok: false } without isError and presents nothing.
	const invalid = { role: "toolResult", toolName: "plan_init", toolCallId: "p2", isError: false, details: { ok: false, error: "Line 3: bad edge" } };
	assert.equal(awaitingPlanReply([plan("p1"), planResult("p1"), typed, plan("p2"), invalid, { role: "assistant", content: [{ type: "text", text: "Fixed?" }] }]), false, "a failed rewrite doesn't re-offer the old plan");
	assert.equal(awaitingPlanReply([plan("p1")]), false, "a plan whose result hasn't arrived isn't presented yet");
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
