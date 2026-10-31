import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-sources-"));
process.env.LH_DATA_DIR = root;
const { stores } = await import("../src/server/stores.ts");
const { reviewCatalog, reviewCandidates } = await import("../src/server/review.ts");
const { parseGeneralSettingsBody } = await import("../src/server/settings-body.ts");
const { sanitizeUserSettings } = await import("../src/core/settings.ts");
const settingsAdapter = await import("../src/store/settings.ts");
const {updateFlashcardCuration}=await import("../src/store/flashcard-curation.ts");
const {syncReviewCollection}=await import("../src/store/review.ts");
after(() => fs.rmSync(root,{recursive:true,force:true}));
it("defaults to chat-provenanced concepts, including merged concepts whose first source was an import", () => {
    stores.settingsStore.writeSettings({version:1,agent:{flashcards:{enabled:false}}});
    const chat = stores.chatStore.createChat("Recent lesson");
    for (const [id, provenance] of [["n_chat",[{chatId:chat.id,messageId:"m1"}]],["n_import",[{chatId:"src_notes",messageId:""}]],["n_both",[{chatId:"src_notes",messageId:""},{chatId:chat.id,messageId:"m2"}]]] as const) {
        stores.graphStore.appendNode({id,name:id,statement:"A claim for "+id,aliases:[],createdAt:new Date().toISOString(),provenance:[...provenance]});
    }
    const only = reviewCatalog(Date.now());
    assert.deepEqual(only.map(card=>card.sourceNodeId),["n_chat","n_both"]);
    assert.ok(only.every(card=>card.deckId===chat.id));
    stores.settingsStore.writeSettings({version:1,general:{flashcardSources:"all"},agent:{flashcards:{enabled:false}}});
    assert.equal(reviewCatalog(Date.now()).length,3);
});
it("validates the source setting and retains sibling General preferences", () => {
    assert.equal(parseGeneralSettingsBody({flashcardSources:"recent"}).ok,false);
    const parsed = parseGeneralSettingsBody({flashcardSources:"all",showReadingThinking:true});
    assert.ok(parsed.ok);
    assert.deepEqual(sanitizeUserSettings({version:1,general:parsed.settings})?.general,{flashcardSources:"all",showReadingThinking:true});
});

it("holds new concepts for curation, hides skipped concepts, and preserves reviewed cards", () => {
    const {readSettings,writeSettings}=settingsAdapter;
    const raw=reviewCandidates(Date.now());
    writeSettings({...readSettings(),version:1,agent:{flashcards:{enabled:true}}});
    assert.equal(reviewCatalog(Date.now()).length,0);
    const kept=raw[0]!;
    updateFlashcardCuration(state=>{state.decisions[kept.revision]={keep:true,priority:90,reason:"Useful"};});
    assert.equal(reviewCatalog(Date.now()).length,1);
    const time=Date.now();
    const memory={stability:1,difficulty:5};const item={memory,interval:1};
    syncReviewCollection([kept],{version:1,deviceId:"22222222-2222-4222-8222-222222222222",attempts:[{id:"11111111-1111-4111-8111-111111111111",deviceId:"22222222-2222-4222-8222-222222222222",sequence:1,cardId:kept.id,cardRevision:kept.revision,rating:3,clientAt:time,shownAt:time,revealedAt:time,foregroundMs:0,engineId:"fixture"}]},{nextStates:()=>({again:item,hard:item,good:item,easy:item})},time);
    updateFlashcardCuration(state=>{state.decisions[kept.revision]={keep:false,priority:0,reason:"Later decision"};});
    assert.ok(reviewCatalog(Date.now()).some(card=>card.id===kept.id));
});

it("uses project membership across all source chats without changing card identity when chats move",async()=>{
    const {projectStore}=await import("../src/store/projects.ts");
    const {setChatOrganization}=await import("../src/store/chats.ts");
    const physics=projectStore.create("Physics"),greenbook=projectStore.create("Green Book");
    const a=stores.chatStore.createChat("Physics lesson"),b=stores.chatStore.createChat("Green Book lesson");
    setChatOrganization(a.id,{projectId:physics.id});setChatOrganization(b.id,{projectId:greenbook.id});
    stores.graphStore.appendNode({id:"n_shared_project",name:"Shared concept",statement:"A stable concept from both chats.",aliases:[],createdAt:new Date().toISOString(),provenance:[{chatId:a.id,messageId:"a"},{chatId:b.id,messageId:"b"}]});
    const before=reviewCandidates(Date.now()).find(card=>card.sourceNodeId==="n_shared_project")!;
    assert.deepEqual(before.projectIds,[physics.id,greenbook.id]);
    setChatOrganization(b.id,{projectId:physics.id});
    const after=reviewCandidates(Date.now()).find(card=>card.id===before.id)!;
    assert.deepEqual(after.projectIds,[physics.id]);assert.equal(after.revision,before.revision);
});
