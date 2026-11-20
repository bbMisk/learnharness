import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createStudyClock, studyDuration, unionStudySpans, type StudySpan } from "../src/core/study-activity.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-"));
process.env.LH_DATA_DIR = dir;
const { chatStore } = await import("../src/store/chats.ts");
const { saveStudySpans, readStudyActivity } = await import("../src/store/study-activity.ts");
const { studyProgress } = await import("../src/server/study-progress.ts");
const { POST } = await import("../app/api/study-activity/route.ts");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

it("stops at exactly two minutes, pauses for focus loss, resumes with new input and skips unseen time after sleep", () => {
	const spans: StudySpan[] = [];
	const clock = createStudyClock((span) => spans.push(span));
	clock.sample(2_000);
	assert.deepEqual(spans, []);
	clock.interact(3_000);
	for (let time = 13_000; time <= 113_000; time += 10_000) clock.sample(time);
	clock.sample(128_000);
	clock.sample(138_000);
	assert.deepEqual(unionStudySpans(spans), [[3_000, 123_000]]);
	clock.interact(141_000);
	clock.interact(144_000);
	clock.pause(148_000);
	clock.sample(155_000);
	clock.interact(156_000);
	clock.sample(166_000);
	clock.sample(260_000);
	clock.sample(270_000);
	assert.deepEqual(unionStudySpans(spans), [
		[3_000, 123_000],
		[141_000, 148_000],
		[156_000, 166_000],
	]);
});

it("extends the idle allowance from the most recent interaction", () => {
	const spans: StudySpan[] = [];
	const clock = createStudyClock((span) => spans.push(span));
	clock.interact(0);
	for (let time = 10_000; time <= 130_000; time += 10_000) {
		clock.sample(time);
		if (time === 60_000) clock.interact(time);
	}
	assert.equal(studyDuration(spans), 130_000);
});

it("validates submissions, deduplicates retries and overlapping lessons, and reports progress across New York midnight", async () => {
	const a = chatStore.createChat("A");
	const b = chatStore.createChat("B", "practice");
	const midnight = Date.parse("2026-11-02T05:00:00Z");
	chatStore.saveMessages(a.id, [
		{ id: "u1", role: "user", content: "private", timestamp: midnight - 90_000 },
		{ id: "u2", role: "user", content: "private", timestamp: midnight + 30_000 },
	]);
	const aFile = path.join(dir, "chats", a.id + ".json");
	const record = JSON.parse(fs.readFileSync(aFile, "utf8"));
	record.learningEvents.push(
		{ kind: "question-answered", id: "answer", at: new Date(midnight + 25_000).toISOString() },
		{ kind: "question-answered", id: "dismissed", outcome: "dismissed", at: new Date(midnight + 26_000).toISOString() },
		{ kind: "practice-concluded", id: "done", at: new Date(midnight + 27_000).toISOString() },
	);
	fs.writeFileSync(aFile, JSON.stringify(record));

	saveStudySpans(a.id, [[midnight - 5_000, midnight + 5_000]]);
	saveStudySpans(b.id, [[midnight, midnight + 8_000]]);
	saveStudySpans(a.id, [[midnight - 5_000, midnight + 5_000]]);
	const progress = studyProgress(midnight + 60_000);
	assert.deepEqual(progress.today, {
		date: "2026-11-02",
		activeSeconds: 8,
		historicalEstimateSeconds: 0,
		questionsAnswered: 1,
		practiceProblemsConcluded: 1,
	});
	assert.deepEqual(progress.thisWeek, {
		startDate: "2026-11-02",
		activeSeconds: 8,
		historicalEstimateSeconds: 0,
		questionsAnswered: 1,
		practiceProblemsConcluded: 1,
	});
	assert.equal(progress.allTime.activeSeconds, 13);
	// Fall-back Sunday begins at 04:00Z even though New York ends the day at UTC-5.
	const fallBackMidnight = Date.parse("2026-11-01T04:00:00Z");
	saveStudySpans(b.id, [[fallBackMidnight - 4_000, fallBackMidnight + 5_000]]);
	assert.equal(studyProgress(Date.parse("2026-11-01T17:00:00Z")).today.activeSeconds, 5);
	assert.equal(progress.allTime.historicalEstimateSeconds, 85);
	assert.ok(!JSON.stringify(progress).includes("private"));
	assert.equal(chatStore.listChats().find(({ id }) => id === a.id)?.timeSpentMs, 10_000);

	const now = Date.now();
	const submit = (chatId: string, spans: unknown) =>
		POST(
			new Request("http://localhost/api/study-activity", {
				method: "POST",
				body: JSON.stringify({ chatId, spans }),
			}),
		);
	assert.equal((await submit(a.id, [[now - 50_000, now]])).status, 400);
	assert.equal((await submit("unknown", [[now - 5_000, now]])).status, 404);
	assert.equal((await submit(a.id, [[now - 10_000, now]])).status, 204);
	assert.equal((await submit(a.id, [[now - 10_000, now]])).status, 204);
	assert.equal(studyDuration(readStudyActivity().lessons[a.id]!), 20_000);
	assert.equal(chatStore.deleteChat(a.id), true);
	assert.equal(readStudyActivity().lessons[a.id], undefined);
	assert.equal(readStudyActivity().startedAt, fallBackMidnight - 4_000);
});
