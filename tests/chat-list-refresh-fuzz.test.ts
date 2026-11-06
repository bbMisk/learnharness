/** Seeded 3,000-step model of the sidebar refresh queue: events, refreshes, dispose/resume, slow fetches. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createChatListRefresher} from '../components/chat-list-refresh.ts';
const sleep=(n:number)=>new Promise(r=>setTimeout(r,n));
test('seeded 3000-step refresh/event/dispose/resume model',async()=>{
 let seed=0x42f00d;const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0};
 let mounted=true, server=0, seen=-1, active=0, max=0, violations=0;let resolves:Array<()=>void>=[];const promises:Promise<void>[]=[];
 const r=createChatListRefresher({debounceMs:1,timeoutMs:1000,fetchList:()=>{if(!mounted)violations++;active++;max=Math.max(max,active);const captured=server;return new Promise<any[]>(resolve=>resolves.push(()=>{active--;resolve([{id:String(captured),busy:true}])}))},fetchProjects:async()=>[],onList:x=>{if(!mounted)violations++;seen=Number(x[0]!.id)},onProjects:()=>{if(!mounted)violations++},onError:()=>{if(!mounted)violations++}});
 for(let i=0;i<3000;i++){
  switch(rand()%8){case 0:server++;r.event({type:'chats-changed'});break;case 1:server++;r.event({type:'turn-started',chatId:'x'});break;case 2:r.event({type:'turn-settled',chatId:'x'});break;case 3:promises.push(r.refresh({projects:false}));break;case 4:if(mounted){mounted=false;r.dispose()}else{mounted=true;r.resume()}break;case 5:resolves.shift()?.();break;case 6:r.event({type:'compaction-changed'});break;case 7:promises.push(r.resync());break;}
  if(i%30===0)await sleep(2);
 }
 mounted=true;r.resume();r.event({type:'chats-changed'});
 for(let i=0;i<20;i++){while(resolves.length)resolves.shift()!();await sleep(3)}
 await Promise.all(promises);r.dispose();assert.equal(violations,0);assert.equal(max,1);assert.equal(seen,server);
});
