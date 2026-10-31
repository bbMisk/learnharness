import assert from "node:assert/strict";
import { it } from "node:test";
import { assertReviewSnapshot, newCardSchedule, reviewQueue, studyDay, type ReviewSnapshot } from "../src/core/review.ts";
const now=Date.parse("2026-10-30T18:00:00Z");
function card(id:string,projectIds?:string[]):ReviewSnapshot["cards"][number]{return {id,projectIds,sourceNodeId:id,revision:id,front:id,back:id,deckId:id,deckName:id,createdAt:now,active:true,schedule:newCardSchedule()};}
it("offers 20 new cards for each project and filters one or several projects",()=>{
 const cards=Array.from({length:50},(_,i)=>card(`n_${i}`,[i<25?"physics":"greenbook"]));
 assert.equal(reviewQueue(cards,now).fresh.length,40);
 const physics=reviewQueue(cards,now,{projectIds:["physics"]});assert.equal(physics.fresh.length,20);assert.equal(physics.selected.length,25);
 assert.ok(physics.queue.every(c=>c.projectIds!.includes("physics")));
 assert.equal(reviewQueue(cards,now,{projectIds:["physics","greenbook"]}).fresh.length,40);
});
it("a completed Physics allowance does not block Green Book or due Physics reviews",()=>{
 const cards:ReviewSnapshot["cards"]=Array.from({length:20},(_,i)=>({...card(`p_${i}`,["physics"]),schedule:{...newCardSchedule(),reps:1,introducedDay:studyDay(now),dueAt:now-1}}));
 cards.push(card("p_new",["physics"]),card("g_new",["greenbook"]));
 const all=reviewQueue(cards,now);assert.equal(all.due.length,20);assert.deepEqual(all.fresh.map(c=>c.id),["g_new"]);
 assert.equal(reviewQueue(cards,now,{projectIds:["physics"]}).newRemaining,0);
 assert.equal(reviewQueue(cards,now,{projectIds:["greenbook"]}).newRemaining,20);
});
it("deduplicates shared concepts across selected projects and preserves old unassigned snapshots",()=>{
 const shared=card("shared",["physics","greenbook"]),unassigned=card("old");
 assert.equal(reviewQueue([shared,unassigned],now,{projectIds:["physics","greenbook"]}).queue.length,1);
 assert.deepEqual(reviewQueue([shared,unassigned],now,{projectIds:["__unassigned"]}).queue.map(c=>c.id),["old"]);
 const snapshot={version:1,collectionId:"collection",revision:1,engineId:"fixture",serverAt:now,cards:[unassigned],receipts:{}};
 assert.doesNotThrow(()=>assertReviewSnapshot(snapshot));
 assert.doesNotThrow(()=>assertReviewSnapshot({...snapshot,projects:[{id:"physics",name:"Physics"}]}));
 assert.throws(()=>assertReviewSnapshot({...snapshot,projects:[{id:"physics",name:1}]}));
 assert.throws(()=>assertReviewSnapshot({...snapshot,cards:[{...shared,projectIds:["physics","physics"]}]}));
});
