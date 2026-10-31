import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { after, beforeEach, it } from "node:test";
import type { Flashcard } from "../src/core/review.ts";
const temp = fs.mkdtempSync(path.join(os.tmpdir(),"lh-flashcard-agent-"));
process.env.LH_DATA_DIR=temp;
process.env.LH_AUTH_FILE=path.join(temp,"auth.json");
const {runFlashcardCuration,abortFlashcardAgent,flashcardAgentActivity}=await import("../src/server/flashcard-agent.ts");
const {readFlashcardCuration,updateFlashcardCuration}=await import("../src/store/flashcard-curation.ts");
const {saveReviewQuestion}=await import("../src/store/review-questions.ts");
const {parseFlashcardTriage}=await import("../src/core/flashcard-curation.ts");
const {parseAgentSettingsBody}=await import("../src/server/settings-body.ts");
const {sanitizeUserSettings}=await import("../src/core/settings.ts");
const {resolveRoleSpec}=await import("../src/core/settings-resolution.ts");
import type {FlashcardAgentDeps} from "../src/server/flashcard-agent.ts";
const at=Date.parse("2026-10-30T18:00:00Z");
function card(index:number):Flashcard{return {id:"card_n_"+index,sourceNodeId:"n_"+index,revision:"rev"+index,front:"Explain "+index,back:"Concept "+index,deckId:"chat_1",deckName:"Lesson",createdAt:at,active:true};}
function harness(count=4,limit=2){
    const records=Array.from({length:count},(_,i)=>card(i));
    const prepared:string[]=[],triaged:string[][]=[];
    let clock=at,syncs=0,enabled=true;
    const deps:FlashcardAgentDeps={options:()=>({enabled,dailyLimit:limit,instructions:"Prioritize conceptual errors."}),candidates:()=>records,reviewed:()=>new Set(),signatureSettings:()=>"fixture",now:()=>clock,
        async triage(cards){triaged.push(cards.map(c=>c.revision));return cards.map((c,i)=>({revision:c.revision,keep:true,priority:100-i,reason:"Useful concept"}));},
        async prepare(c){prepared.push(c.revision);const question={prompt:c.front,options:[c.back,"B","C","D"],correctIndex:0,explanation:"The source supports the first statement."};saveReviewQuestion(c.revision,question);c.mcq=question;return question;},
        async sync(){syncs++;},
    };
    return {deps,records,prepared,triaged,setClock:(value:number)=>{clock=value;},disable:()=>{enabled=false;},syncs:()=>syncs};
}
beforeEach(()=>{abortFlashcardAgent();for(const name of ["flashcard-curation.json","flashcard-questions.json"])fs.rmSync(path.join(temp,name),{force:true});});
after(()=>fs.rmSync(temp,{recursive:true,force:true}));

it("triages once, prepares only the daily budget, then catches up on the next study day",async()=>{
    const h=harness();await runFlashcardCuration(false,h.deps);
    assert.equal(h.triaged.length,1);assert.equal(h.prepared.length,2);assert.equal(h.syncs(),1);
    await runFlashcardCuration(false,h.deps);assert.equal(h.triaged.length,1);assert.equal(h.prepared.length,2);
    h.setClock(at+86400000);await runFlashcardCuration(false,h.deps);assert.equal(h.prepared.length,4);
    assert.equal(Object.keys(readFlashcardCuration().days).length,2);
});
it("honors triage skips, exact duplicates, and previously reviewed cards",async()=>{
    const h=harness(4,20);h.records[1]!.back=h.records[0]!.back;
    h.deps.reviewed=()=>new Set([h.records[2]!.id]);
    h.deps.triage=async cards=>cards.map(c=>({revision:c.revision,keep:c.id!==h.records[3]!.id,priority:90,reason:"Decision"}));
    await runFlashcardCuration(false,h.deps);
    assert.deepEqual(h.prepared,["rev0"]);assert.equal(readFlashcardCuration().decisions.rev1!.keep,false);
    assert.equal(readFlashcardCuration().decisions.rev3!.keep,false);
});
it("serializes overlapping triggers and exposes a cancellable background row",async()=>{
    const h=harness(2,2);let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});
    h.deps.triage=async(_cards,_instructions,signal)=>{began();await new Promise<void>((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true}));return [];};
    const first=runFlashcardCuration(false,h.deps);await started;
    assert.equal(flashcardAgentActivity().length,1);await runFlashcardCuration(false,h.deps);
    abortFlashcardAgent();await first;assert.equal(flashcardAgentActivity().length,0);
    assert.equal(h.prepared.length,0);assert.match(readFlashcardCuration().lastError!,/Stopped/);
});
it("resumes a crash-reserved card without charging another daily slot",async()=>{
    const h=harness(1,1);const {studyDay}=await import("../src/core/review.ts");
    updateFlashcardCuration(next=>{next.days[String(studyDay(at))]=["rev0"];next.decisions.rev0={keep:true,priority:80,reason:"Previously selected"};});
    await runFlashcardCuration(false,h.deps);assert.deepEqual(h.prepared,["rev0"]);
    assert.equal(Object.values(readFlashcardCuration().days)[0]!.length,1);
});
it("does not retry a model failure on every activity fetch, but permits explicit retry",async()=>{
    const h=harness(1,1);let calls=0;
    h.deps.triage=async()=>{calls++;throw new Error("model unavailable");};
    await runFlashcardCuration(false,h.deps);await runFlashcardCuration(false,h.deps);assert.equal(calls,1);
    await runFlashcardCuration(true,h.deps);assert.equal(calls,2);
});
it("rechecks source eligibility and the master toggle before preparing selected cards",async()=>{
    const h=harness(1,1);h.deps.triage=async cards=>{h.disable();return cards.map(c=>({revision:c.revision,keep:true,priority:90,reason:"Selected"}));};
    await runFlashcardCuration(false,h.deps);assert.equal(h.prepared.length,0);
    const second=harness(1,1);second.records[0]!.revision="secondrev";second.deps.triage=async cards=>{second.deps.candidates=()=>[];return cards.map(c=>({revision:c.revision,keep:true,priority:90,reason:"Selected"}));};
    await runFlashcardCuration(true,second.deps);assert.equal(second.prepared.length,0);
});
it("rejects invented or duplicate triage revisions and validates settings and model resolution",()=>{
    const decision={revision:"r1",keep:true,priority:50,reason:"Reason"};
    assert.throws(()=>parseFlashcardTriage({decisions:[{...decision,revision:"invented"}]},["r1"]));
    assert.throws(()=>parseFlashcardTriage({decisions:[decision,decision]},["r1","r2"]));
    for(const flashcards of [{enabled:"yes"},{dailyLimit:0},{dailyLimit:101},{instructions:42}])assert.equal(parseAgentSettingsBody({flashcards}).ok,false);
    const settings=sanitizeUserSettings({version:1,agent:{flashcards:{enabled:false,dailyLimit:4,instructions:"Focus on reasoning"}},models:{cheap:{model:{provider:"test",id:"cheap-model"}}}})!;
    assert.deepEqual(settings.agent!.flashcards,{enabled:false,dailyLimit:4,instructions:"Focus on reasoning"});
    assert.equal(resolveRoleSpec("flashcardCurator",settings)!.id,"cheap-model");
});
it("charges each preparation to its actual study day when a run crosses 4am",async()=>{
    const h=harness(3,2),prepare=h.deps.prepare;let calls=0;
    h.deps.prepare=async(...args)=>{const q=await prepare(...args);if(++calls===1)h.setClock(at+86400000);return q;};
    await runFlashcardCuration(false,h.deps);await runFlashcardCuration(false,h.deps);
    const days=Object.values(readFlashcardCuration().days);
    assert.deepEqual(days.map(items=>items.length).sort(),[1,2]);assert.equal(h.prepared.length,3);
});
it("restores long candidate hashes from short labels and rejects unknown, duplicated or incomplete labels",async()=>{
    const {parseLabeledFlashcardTriage}=await import("../src/core/flashcard-curation.ts");
    const revisions=Array.from({length:40},(_,index)=>index.toString(16).padStart(64,"0"));
    const decisions=revisions.map((_,index)=>({id:`c${index+1}`,keep:true,priority:80,reason:"Durable concept"}));
    assert.deepEqual(parseLabeledFlashcardTriage({decisions},revisions).map(item=>item.revision),revisions);
    assert.throws(()=>parseLabeledFlashcardTriage({decisions:[{...decisions[0],id:"c41"},...decisions.slice(1)]},revisions));
    assert.throws(()=>parseLabeledFlashcardTriage({decisions:[decisions[0],...decisions.slice(0,39)]},revisions));
    assert.throws(()=>parseLabeledFlashcardTriage({decisions:decisions.slice(1)},revisions));
});

it("shares the allowance across chats in one project and gives other projects an independent allowance",async()=>{
    const h=harness(6,2);
    h.records.forEach((card,index)=>{card.projectIds=[index<3?"physics":"greenbook"];card.deckId=`chat_${index}`;});
    await runFlashcardCuration(false,h.deps);
    assert.deepEqual(h.prepared,["rev0","rev3","rev1","rev4"]);
    const state=readFlashcardCuration(),day=String((await import("../src/core/review.ts")).studyDay(at));
    assert.equal(state.projectDays![day]!.physics!.length,2);
    assert.equal(state.projectDays![day]!.greenbook!.length,2);
    await runFlashcardCuration(false,h.deps);assert.equal(h.prepared.length,4);
});
it("migrates used global slots to their projects without using another project's allowance",async()=>{
    const h=harness(4,2),day=String((await import("../src/core/review.ts")).studyDay(at));
    h.records.forEach((card,index)=>{card.projectIds=[index<2?"physics":"greenbook"];});
    for(const card of h.records.slice(0,2))card.mcq={prompt:"Ready",options:[card.back,"B","C","D"],correctIndex:0,explanation:"Source"};
    updateFlashcardCuration(next=>{next.days[day]=["rev0","rev1"];});
    await runFlashcardCuration(false,h.deps);
    assert.deepEqual(h.prepared,["rev2","rev3"]);
    assert.deepEqual(readFlashcardCuration().projectDays![day],{physics:["rev0","rev1"],greenbook:["rev2","rev3"]});
});
it("charges a concept shared by projects once in each and preserves reservations after chats move",async()=>{
    const h=harness(3,1),day=String((await import("../src/core/review.ts")).studyDay(at));
    h.records[0]!.projectIds=["physics","greenbook"];
    h.records[1]!.projectIds=["physics"];h.records[2]!.projectIds=["greenbook"];
    await runFlashcardCuration(false,h.deps);assert.deepEqual(h.prepared,["rev0"]);
    const before=readFlashcardCuration().projectDays![day];
    h.records[0]!.projectIds=["new_project"];
    await runFlashcardCuration(false,h.deps);
    assert.deepEqual(readFlashcardCuration().projectDays![day],before);
    assert.equal(h.prepared.length,1);
});
