import React from "react";
(globalThis as Record<string, unknown>).React = React;
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { jobDisplay, jobElapsedMs, jobTaskFromInput } from "../src/core/job-visibility.ts";
import type { JobRecord } from "../src/core/contracts/jobs.ts";
import { JobDetails } from "../components/job-details.tsx";
import { DispatchCard } from "../components/artifacts/dispatch-card.tsx";
import { JobsContext } from "../components/jobs-context.ts";
import { toBlobs } from "../components/activity-dock.tsx";
import { jobStore } from "../src/store/jobs.ts";
import { chatStore } from "../src/store/chats.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { listJobs } from "../src/server/jobs.ts";

const createdAt = "2026-10-28T12:00:00Z";
const base: JobRecord = { id: "visibility", kind: "visual", chatId: "visibility-test", toolCallId: "draw", status: "running", activity: "drawing figure", createdAt, updatedAt: createdAt };
const ready: JobRecord = { ...base, result: { svg: '<svg width="100" height="100"><circle cx="50" cy="50" r="20" /></svg>' }, generatedAt: "2026-10-28T12:00:10Z", deliveryState: "waiting-answer" };

describe("agent visibility without changing delivery", () => {
	it("separates generation from pending answer, lesson delivery, and terminal states", () => {
		assert.deepEqual(jobDisplay(base), { label: "Working", working: true });
		assert.equal(jobDisplay(ready).label, "Ready — waiting for your answer");
		assert.equal(jobDisplay({ ...ready, deliveryState: "waiting-lesson" }).label, "Ready — waiting for the lesson");
		assert.equal(jobDisplay({ ...ready, deliveryState: "delivering" }).label, "Ready — delivering to lesson");
		assert.equal(jobDisplay({ ...ready, status: "done" }).label, "Delivered");
		assert.equal(jobDisplay({ ...ready, status: "done", delivery: { kind: "result", status: "pending" } }).label, "Ready — waiting for your answer");
		assert.equal(jobDisplay({ ...ready, status: "error" }).label, "Failed");
		assert.equal(ready.status, "running", "presentation never changes the delivery protocol");
	});
	it("freezes work time on generation and does not fabricate legacy timings", () => {
		assert.equal(jobElapsedMs(ready, Date.parse(createdAt) + 999999), 10000);
		assert.equal(jobElapsedMs({ ...ready, generatedAt: undefined }, Date.now()), null);
		assert.equal(jobElapsedMs(base, Date.parse(createdAt) + 2000), 2000);
		const blob = toBlobs({ jobs: [{ ...ready, title: "Lesson", contextLimit: null }], extractions: [] })[0]!;
		assert.equal(blob.activity, "Ready — waiting for your answer");
	});
	it("retains task fields without copying arbitrary hidden prompt fields", () => {
		assert.equal(jobTaskFromInput({ brief: "Draw rings", context: "Same thickness", secret: "hidden" }), "Draw rings\n\nSame thickness");
		assert.equal(jobTaskFromInput(null), undefined);
		assert.equal(jobTaskFromInput({ brief: "x".repeat(10000) })?.length, 8000);
	});
	it("previews a ready figure and history without delivering it or exposing raw HTML text", () => {
		const before = JSON.stringify(ready);
		const html = renderToStaticMarkup(<JobDetails job={{ ...ready, task: "Draw a ring", activityHistory: [{ at: createdAt, text: "drawing figure" }, { at: ready.generatedAt!, text: "render_svg: inspected" }] }} />);
		assert.match(html, /Draw a ring/); assert.match(html, /render_svg: inspected/);
		assert.match(html, /data-testid="visual-svg"/); assert.match(html, /<circle/);
		assert.equal(JSON.stringify(ready), before);
	});
	it("keeps delivered details accessible and mounts previews only when opened", () => {
		const html = renderToStaticMarkup(<JobsContext.Provider value={[{ ...ready, status: "done" }]}><DispatchCard toolCallId="draw" kind="visual" /></JobsContext.Provider>);
		assert.match(html, /<details/); assert.match(html, /Inspect Figure agent/); assert.match(html, /Delivered/);
		assert.doesNotMatch(html, /data-testid="visual-svg"/, "closed inspectors do not mount expensive previews");
	});
	it("projects a saved result behind a pending question without changing the chat", () => {
		const chat = chatStore.createChat("Agent visibility test");
		const job = jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId: "draw" });
		try {
			chatStore.saveMessages(chat.id, [{ ...fauxAssistantMessage([
				fauxToolCall("visual", { brief: "Draw an annulus" }, { id: "draw" }),
				fauxToolCall("quiz", { question: "Compare the rings", choices: ["a", "b"] }, { id: "quiz" })
			]), id: "a1" }]);
			jobStore.updateJob(job.id, { result: ready.result, activity: "delivering result" });
			const before = JSON.stringify(chatStore.getChat(chat.id));
			const projected = listJobs(chat.id)[0]!;
			assert.equal(projected.deliveryState, "waiting-answer");
			assert.equal(projected.task, "Draw an annulus");
			assert.equal(jobStore.getJob(job.id)!.status, "running");
			assert.equal(JSON.stringify(chatStore.getChat(chat.id)), before);
		} finally { jobStore.deleteJobsForChat(chat.id); chatStore.deleteChat(chat.id); }
	});
	it("persists activity history and first completion time through reload and recovery writes", () => {
		const job = jobStore.createJob({ kind: "visual", chatId: "visibility-store-test", toolCallId: "test" });
		try {
			jobStore.updateJob(job.id, { activity: "write_svg" });
			jobStore.updateJob(job.id, { activity: "write_svg" });
			const complete = jobStore.updateJob(job.id, { result: { svg: "<svg/>" }, activity: "delivering result" })!;
			jobStore.updateJob(job.id, { activity: "recovering: re-delivering" });
			const loaded = jobStore.getJob(job.id)!;
			assert.deepEqual(loaded.activityHistory?.map(e => e.text), ["starting", "write_svg", "delivering result", "recovering: re-delivering"]);
			assert.equal(loaded.generatedAt, complete.generatedAt);
			assert.equal(loaded.status, "running");
			assert.equal(listJobs(job.chatId)[0]!.deliveryState, "delivering");
			for (let i = 0; i < 220; i++) jobStore.updateJob(job.id, { activity: String(i) });
			assert.equal(jobStore.getJob(job.id)!.activityHistory?.length, 200);
		} finally { jobStore.deleteJobsForChat(job.chatId); }
	});
});
