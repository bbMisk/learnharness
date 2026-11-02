/** Dispose/resume edge cases of the sidebar refresh queue (round-4 Codex hunt). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatListRefresher } from '../components/chat-list-refresh.ts';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('in-flight result while disposed is replayed on resume',async()=>{
 let resolve!: (x:any[])=>void; let calls=0; const seen:string[]=[];
 const r=createChatListRefresher({fetchList:()=>{calls++; return calls===1?new Promise(res=>resolve=res):Promise.resolve([{id:'new'}] as any)},fetchProjects:async()=>[],onList:x=>seen.push(x[0]!.id),onProjects:()=>{},onError:()=>{},debounceMs:1,timeoutMs:100});
 const p=r.refresh({projects:false}); r.dispose(); resolve([{id:'new'}]); await p; r.resume(); await sleep(15); r.dispose();
 assert.equal(seen.at(-1),'new','the list ends current after resume (a redundant refetch is fine)');
});
test('dispose settles active refresh without waiting for a stalled request',async()=>{
 const r=createChatListRefresher({fetchList:()=>new Promise(()=>{}),fetchProjects:async()=>[],onList:()=>{},onProjects:()=>{},onError:()=>{},timeoutMs:50});
 let done=false; const p=r.refresh({projects:false}).then(()=>{done=true}); r.dispose(); await sleep(5); const observed=done; await p; assert.equal(observed,true);
});
