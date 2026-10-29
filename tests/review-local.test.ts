import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { it } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { createReviewEngine, REVIEW_ENGINE } from "../src/core/review-engine.ts";
import { newCardSchedule, scheduleToken } from "../src/core/review.ts";
import type { ReviewAttempt, ReviewSnapshot } from "../src/core/review.ts";
import { openReviewDatabase, enqueueReview, reconcileReviewSnapshot } from "../web/review/database.ts";

const engine = await createReviewEngine(await fs.readFile(new URL("../vendor/fsrs/engine.wasm", import.meta.url)));
const at = Date.parse("2026-10-28T18:00:00Z");
const snapshot = (): ReviewSnapshot => ({ version: 1, collectionId: "collection-1", revision: 1, engineId: REVIEW_ENGINE.engineId, serverAt: at, receipts: {}, cards: [{ id: "card_n_1", sourceNodeId: "n_1", revision: "r1", front: "Explain the concept", back: "A precise claim", deckId: "deck-1", deckName: "A topic", createdAt: at - 100000, active: true, schedule: newCardSchedule() }] });
const draft = { cardId: "card_n_1", cardRevision: "r1", rating: 3 as const, clientAt: at, shownAt: at - 10000, revealedAt: at - 1000, foregroundMs: 10000, engineId: REVIEW_ENGINE.engineId };

it("commits a review before resolving and keeps it after closing/reopening the database", async () => {
	const factory = new IDBFactory();
	const db = await openReviewDatabase(factory);
	await reconcileReviewSnapshot(db, snapshot(), 0);
	await enqueueReview(db, draft, scheduleToken(snapshot().cards[0]!), engine);
	const original = await db.read();
	assert.equal(original.pending.length, 1);
	assert.equal(original.pending[0]!.sequence, 1);
	db.close();
	const reopened = await openReviewDatabase(factory);
	assert.deepEqual((await reopened.read()).pending, original.pending);
	reopened.close();
});

it("does not let two tabs grade the same cached card state twice", async () => {
	const factory = new IDBFactory();
	const first = await openReviewDatabase(factory), second = await openReviewDatabase(factory);
	await reconcileReviewSnapshot(first, snapshot(), 0);
	const token = scheduleToken(snapshot().cards[0]!);
	const results = await Promise.allSettled([enqueueReview(first, draft, token, engine), enqueueReview(second, draft, token, engine)]);
	assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
	assert.equal((await first.read()).pending.length, 1);
	first.close(); second.close();
});

it("retains reviews made during a sync and clears only durable server receipts", async () => {
	const db = await openReviewDatabase(new IDBFactory());
	await reconcileReviewSnapshot(db, snapshot(), 0);
	await enqueueReview(db, draft, scheduleToken(snapshot().cards[0]!), engine);
	const state = await db.read(), attempt = state.pending[0]!;
	await db.change(current => ({ ...current, sequence: 2, pending: [...current.pending, { ...attempt, id: "33333333-3333-4333-8333-333333333333", sequence: 2, clientAt: at + 600000 }] }));
	const synced = snapshot(); synced.revision = 2;
	synced.receipts[state.deviceId] = { through: 1, extra: [] };
	await reconcileReviewSnapshot(db, synced, 0);
	assert.deepEqual((await db.read()).pending.map(attempt => attempt.sequence), [2]);
	await reconcileReviewSnapshot(db, snapshot(), 0); // late response with an older revision
	assert.equal((await db.read()).snapshot!.revision, 2);
	assert.deepEqual((await db.read()).pending.map(attempt => attempt.sequence), [2]);
	db.close();
});

it("uses sparse receipts to avoid reapplying reviews uploaded by another tab", async () => {
	const db = await openReviewDatabase(new IDBFactory());
	await reconcileReviewSnapshot(db, snapshot(), 0);
	const state = await db.read();
	const pending = [1, 2, 3].map(sequence => ({ ...draft, deviceId: state.deviceId, sequence, id: crypto.randomUUID() } as ReviewAttempt));
	await db.change(current => ({ ...current, sequence: 3, pending }));
	const response = snapshot(); response.revision = 3; response.receipts[state.deviceId] = { through: 1, extra: [3] };
	await reconcileReviewSnapshot(db, response, 0);
	assert.deepEqual((await db.read()).pending.map(attempt => attempt.sequence), [2]);
	db.close();
});

it("aborts failed writes without consuming a sequence or deleting pending data", async () => {
	const db = await openReviewDatabase(new IDBFactory());
	const initial = await db.read();
	await assert.rejects(db.change(current => { current.sequence++; throw new Error("Quota/write failure"); }), /Quota\/write failure/);
	assert.deepEqual(await db.read(), initial);
	const changed = snapshot(); changed.version = 2 as 1;
	await assert.rejects(reconcileReviewSnapshot(db, changed, 0), /version|update/i);
	assert.deepEqual(await db.read(), initial);
	db.close();
});
