import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { it } from "node:test";
import { createReviewEngine } from "../src/core/review-engine.ts";
import { applyReview, assertReviewQuestion, dueOnStudyDay, localReviewCards, newCardSchedule, replayCard, reviewMode, validateReviewRequest, type StoredReview } from "../src/core/review.ts";
const engine = await createReviewEngine(await fs.readFile(new URL("../vendor/fsrs/engine.wasm", import.meta.url)));
const at = Date.parse("2026-10-30T18:00:00Z");
const good = {mode:"mcq" as const, rating:3 as const};

it("graduates three scheduled recognition successes across study days without replacing FSRS memory", () => {
    let state = newCardSchedule();
    assert.equal(reviewMode(state), "mcq");
    state = applyReview(state, good, at, engine);
    assert.equal(state.mode, "mcq"); assert.equal(state.mcqStreak, 1);
    state = applyReview(state, good, state.dueAt, engine);
    assert.equal(state.mode, "mcq"); assert.equal(state.mcqStreak, 2);
    assert.ok(state.dueAt <= dueOnStudyDay(at, 1));
    state = applyReview(state, good, state.dueAt, engine);
    assert.equal(state.mode, "recall"); assert.equal(state.mcqStreak, 3);
    assert.equal(state.reps, 3); assert.ok(state.memory!.stability > 0);
    const failedRecall = applyReview(state, {mode:"recall", rating:1}, state.dueAt, engine);
    assert.equal(failedRecall.mode, "recall"); assert.equal(failedRecall.lapses, 1);
});

it("does not graduate immediate repeats or carry a streak across a wrong answer", () => {
    let state = applyReview(newCardSchedule(), good, at, engine);
    for (let i=0; i<5; i++) state = applyReview(state, good, at+1000, engine);
    assert.equal(state.mcqStreak, 1); assert.equal(state.mode, "mcq");
    state = applyReview(state, {mode:"mcq", rating:1}, state.dueAt, engine);
    assert.equal(state.mcqStreak, 0); assert.equal(state.mcqFirstDay, null);
});

it("preserves legacy recall and converges between offline replay and sorted host history", () => {
    const legacy = applyReview(newCardSchedule(), {rating:3}, at, engine);
    assert.equal(reviewMode(legacy), "recall");
    assert.equal(applyReview(legacy, good, legacy.dueAt, engine).mode, undefined, "an older queued MCQ cannot downgrade recall");
    const deviceId = "22222222-2222-4222-8222-222222222222";
    const events: StoredReview[] = [at,at+600000,dueOnStudyDay(at,1)].map((time,index) => ({id:`11111111-1111-4111-8111-11111111111${index}`, deviceId, sequence:index+1, cardId:"card_n_1", cardRevision:"r1", rating:3, mode:"mcq", selectedIndex:0, clientAt:time, shownAt:time-1000, revealedAt:time, foregroundMs:1000, engineId:"test", effectiveAt:time, receivedAt:time, timeAdjusted:false}));
    const schedule = replayCard([...events].reverse(), engine);
    const cards = localReviewCards({version:1,collectionId:"test",revision:0,engineId:"test",serverAt:at,cards:[{id:"card_n_1",sourceNodeId:"n_1",revision:"r1",front:"Q",back:"A",deckId:"d",deckName:"D",createdAt:at,active:true,schedule:newCardSchedule()}],receipts:{}},events,engine);
    assert.deepEqual(cards[0]!.schedule, schedule);
    assert.equal(schedule.mode,"recall");
});

it("rejects invalid choices and malformed or ambiguous generated options", () => {
    const q = {prompt:"Which?", options:["A","B","C","D"],correctIndex:0,explanation:"A follows from the source; B, C and D do not."};
    assert.doesNotThrow(() => assertReviewQuestion(q));
    for (const patch of [{options:["A","a","C","D"]},{correctIndex:4},{explanation:""}]) assert.throws(() => assertReviewQuestion({...q,...patch}));
    const base = {id:"11111111-1111-4111-8111-111111111111",deviceId:"22222222-2222-4222-8222-222222222222",sequence:1,cardId:"card_n_1",cardRevision:"r1",mode:"mcq",selectedIndex:0,rating:3,clientAt:at,shownAt:at,revealedAt:at,foregroundMs:0,engineId:"test"};
    for (const patch of [{rating:4},{selectedIndex:4},{mode:"other"},{mode:"recall"}]) assert.throws(() => validateReviewRequest({version:1,deviceId:base.deviceId,attempts:[{...base,...patch}]}));
});
