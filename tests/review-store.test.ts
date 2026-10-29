import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";
import type { Flashcard, ReviewAttempt } from "../src/core/review.ts";
import { createReviewEngine, REVIEW_ENGINE } from "../src/core/review-engine.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-store-"));
process.env.LH_DATA_DIR = temp;
const { syncReviewCollection, readReviewArchive } = await import("../src/store/review.ts");
const file = path.join(temp, "flashcards.json");
const engine = await createReviewEngine(fs.readFileSync(new URL("../vendor/fsrs/engine.wasm", import.meta.url)));
const at = Date.parse("2026-10-28T18:00:00Z");
const card: Flashcard = { id: "card_n_1", sourceNodeId: "n_1", revision: "r1", front: "Explain a concept", back: "The precise claim", deckId: "src_1", deckName: "A topic", createdAt: at - 86400000, active: true };
const device = "22222222-2222-4222-8222-222222222222";
const attempt: ReviewAttempt = { id: "11111111-1111-4111-8111-111111111111", deviceId: device, sequence: 1, cardId: card.id, cardRevision: card.revision, rating: 3, clientAt: at, shownAt: at - 10000, revealedAt: at - 1000, foregroundMs: 10000, engineId: REVIEW_ENGINE.engineId };
const request = (attempts: ReviewAttempt[], deviceId = device) => ({ version: 1, deviceId, attempts });
beforeEach(() => fs.rmSync(file, { force: true }));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

it("starts downloaded graph cards as new without inventing study history", () => {
	const result = syncReviewCollection([card], undefined, engine, at);
	assert.equal(result.cards[0]!.schedule.phase, "new");
	assert.equal(result.cards[0]!.schedule.reps, 0);
	assert.equal(readReviewArchive()!.attempts.length, 0);
});

it("stores a review once when its committed response is lost and retried", () => {
	const first = syncReviewCollection([card], request([attempt]), engine, at + 1000);
	const before = fs.readFileSync(file, "utf8");
	const retried = syncReviewCollection([card], request([attempt]), engine, at + 2000);
	assert.equal(readReviewArchive()!.attempts.length, 1);
	assert.equal(retried.revision, first.revision);
	assert.equal(fs.readFileSync(file, "utf8"), before, "retry does not rewrite the collection");
	assert.deepEqual(retried.receipts[device], { through: 1, extra: [] });
	assert.equal(retried.cards[0]!.schedule.reps, 1);
});

it("rejects event and sequence collisions atomically", () => {
	syncReviewCollection([card], request([attempt]), engine, at + 1000);
	const before = fs.readFileSync(file, "utf8");
	for (const changed of [{ ...attempt, rating: 1 }, { ...attempt, id: "33333333-3333-4333-8333-333333333333" }]) {
		assert.throws(() => syncReviewCollection([card], request([changed as ReviewAttempt]), engine, at + 2000), /collision/i);
		assert.equal(fs.readFileSync(file, "utf8"), before);
	}
});

it("converges when an older subway review arrives after another device's newer review", () => {
	const later = { ...attempt, id: "33333333-3333-4333-8333-333333333333", deviceId: "44444444-4444-4444-8444-444444444444", clientAt: at + 600000 };
	syncReviewCollection([card], request([later], later.deviceId), engine, at + 700000);
	const backwards = syncReviewCollection([card], request([attempt]), engine, at + 800000);
	assert.equal(backwards.cards[0]!.schedule.reps, 2);
	fs.rmSync(file);
	syncReviewCollection([card], request([attempt]), engine, at + 700000);
	const ordered = syncReviewCollection([card], request([later], later.deviceId), engine, at + 800000);
	assert.deepEqual(backwards.cards[0]!.schedule, ordered.cards[0]!.schedule);
});

it("keeps historical card versions and accepts offline reviews of a retired card", () => {
	syncReviewCollection([card], request([attempt]), engine, at + 1000);
	const changed = { ...card, revision: "r2", back: "An improved precise claim" };
	syncReviewCollection([changed], undefined, engine, at + 2000);
	const second = { ...attempt, id: "33333333-3333-4333-8333-333333333333", sequence: 2, clientAt: at + 600000 };
	const retired = syncReviewCollection([], request([second]), engine, at + 700000);
	assert.equal(retired.cards[0]!.active, false);
	assert.equal(retired.cards[0]!.schedule.reps, 2);
	assert.equal(readReviewArchive()!.versions[`${card.id}:r1`]!.back, card.back);
	assert.equal(readReviewArchive()!.versions[`${card.id}:r2`]!.back, changed.back);
});

it("retains raw device times while bounding impossible times for scheduling", () => {
	const future = { ...attempt, clientAt: at + 86400000 };
	syncReviewCollection([card], request([future]), engine, at);
	const stored = readReviewArchive()!.attempts[0]!;
	assert.equal(stored.clientAt, future.clientAt);
	assert.equal(stored.effectiveAt, at);
	assert.equal(stored.timeAdjusted, true);
});

it("refuses corrupt/newer collections without resetting them or acknowledging reviews", () => {
	for (const content of ['{"version":99}', '{not-json']) {
		fs.writeFileSync(file, content);
		assert.throws(() => syncReviewCollection([card], request([attempt]), engine, at));
		assert.equal(fs.readFileSync(file, "utf8"), content);
	}
});
