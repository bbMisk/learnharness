import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { it } from "node:test";
import { createReviewEngine } from "../src/core/review-engine.ts";
import { deviceReceipts, dueOnStudyDay, isReceipted, newCardSchedule, replayCard, reviewChoices, studyDay, validateReviewRequest } from "../src/core/review.ts";
import type { ReviewAttempt, StoredReview } from "../src/core/review.ts";

const engine = await createReviewEngine(await fs.readFile(new URL("../vendor/fsrs/engine.wasm", import.meta.url)));
const at = Date.parse("2026-10-28T18:00:00Z");
const attempt: ReviewAttempt = { id: "11111111-1111-4111-8111-111111111111", deviceId: "22222222-2222-4222-8222-222222222222", sequence: 1, cardId: "card_n_1", cardRevision: "revision-1", rating: 3, clientAt: at, shownAt: at - 10000, revealedAt: at - 2000, foregroundMs: 10000, engineId: "fixture" };

it("uses 4am New York study days across both daylight-saving changes", () => {
	assert.equal(studyDay(Date.parse("2026-03-08T07:59:59Z")), Date.UTC(2026, 2, 7) / 86400000);
	assert.equal(studyDay(Date.parse("2026-03-08T08:00:00Z")), Date.UTC(2026, 2, 8) / 86400000);
	assert.equal(studyDay(Date.parse("2026-11-01T08:59:59Z")), Date.UTC(2026, 9, 31) / 86400000);
	assert.equal(studyDay(Date.parse("2026-11-01T09:00:00Z")), Date.UTC(2026, 10, 1) / 86400000);
	assert.equal(dueOnStudyDay(Date.parse("2026-03-07T17:00:00Z"), 1), Date.parse("2026-03-08T08:00:00Z"));
});

it("uses the upstream memory model with Anki-style learning and relearning steps", () => {
	const choices = reviewChoices(newCardSchedule(), at, engine);
	assert.equal(choices[1].dueAt, at + 60000);
	assert.equal(choices[2].dueAt, at + 330000);
	assert.equal(choices[3].dueAt, at + 600000);
	assert.equal(choices[3].phase, "learning");
	assert.ok(Math.abs(choices[3].memory!.stability - 2.3065) < 0.000001);
	assert.equal(choices[4].phase, "review");
	const graduated = reviewChoices(choices[3], at + 600000, engine)[3];
	assert.equal(graduated.phase, "review");
	assert.ok(graduated.intervalDays >= 1);
	const failed = reviewChoices(graduated, graduated.dueAt, engine)[1];
	assert.equal(failed.phase, "relearning");
	assert.equal(failed.lapses, 1);
	assert.equal(failed.dueAt, graduated.dueAt + 600000);
});

it("keeps sparse receipts until sequence gaps arrive", () => {
	const sparse = deviceReceipts([attempt, { ...attempt, sequence: 3 }]);
	assert.deepEqual(sparse[attempt.deviceId], { through: 1, extra: [3] });
	assert.equal(isReceipted({ ...attempt, sequence: 2 }, sparse), false);
	assert.equal(isReceipted({ ...attempt, sequence: 3 }, sparse), true);
	assert.deepEqual(deviceReceipts([attempt, { ...attempt, sequence: 3 }, { ...attempt, sequence: 2 }])[attempt.deviceId], { through: 3, extra: [] });
});

it("replays out-of-order device arrivals into the same canonical schedule", () => {
	const reviews: StoredReview[] = [
		{ ...attempt, receivedAt: at, effectiveAt: at, timeAdjusted: false },
		{ ...attempt, id: "33333333-3333-4333-8333-333333333333", sequence: 2, clientAt: at + 600000, effectiveAt: at + 600000, receivedAt: at + 600000, timeAdjusted: false },
	];
	const ordered = replayCard(reviews, engine);
	assert.equal(ordered.reps, 2);
	assert.equal(ordered.phase, "review");
	assert.deepEqual(replayCard([...reviews].reverse(), engine), ordered);
});

it("rejects malformed ratings, identifiers, sequences and unsupported protocols", () => {
	assert.deepEqual(validateReviewRequest({ version: 1, deviceId: attempt.deviceId, attempts: [attempt] }).attempts, [attempt]);
	for (const patch of [{ rating: 0 }, { rating: 5 }, { sequence: 0 }, { id: "../escape" }, { clientAt: Infinity }, { foregroundMs: -1 }]) {
		assert.throws(() => validateReviewRequest({ version: 1, deviceId: attempt.deviceId, attempts: [{ ...attempt, ...patch }] }));
	}
	assert.throws(() => validateReviewRequest({ version: 2, deviceId: attempt.deviceId, attempts: [attempt] }));
});
