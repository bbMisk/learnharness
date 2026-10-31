import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DictationBar, type Dictation } from "../components/dictation.tsx";
import { useTypeWhisperDictation } from "../components/typewhisper-dictation.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {window:dom.window,document:dom.document,HTMLElement:dom.window.HTMLElement,HTMLTextAreaElement:dom.window.HTMLTextAreaElement,HTMLInputElement:dom.window.HTMLInputElement,CustomEvent:dom.window.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true});
// Linkedom does not model focus or layout; keep those browser seams explicit.
let focused: Element | null = null;
Object.defineProperty(document,"activeElement",{get:()=>focused});
dom.window.HTMLElement.prototype.focus = function(){focused=this;};
dom.window.HTMLElement.prototype.getClientRects = function(){return [{}] as never;};
const originalFetch=globalThis.fetch;
let root:Root|undefined,host:HTMLDivElement|undefined,current:Dictation;
function Fixture(){current=useTypeWhisperDictation(true);return <><textarea defaultValue="Draft"/><input type="text"/><DictationBar dictation={current}/></>;}
afterEach(async()=>{await act(async()=>root?.unmount());host?.remove();root=undefined;globalThis.fetch=originalFetch;focused=null;});
async function until(predicate:()=>boolean){for(let n=0;n<30&&!predicate();n++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});assert.ok(predicate());}

test("End transcription restores its recording field, sends one stop, and waits for final insertion",async()=>{
 let stopped=0,completed=false;
 globalThis.fetch=(async(_url,init)=>{
  if(init?.method==="POST"){
   const action=JSON.parse(init.body as string).action;
   if(action==="stop")stopped++;
   return Response.json({id:"session",status:action==="start"?"recording":"processing"});
  }
  if(stopped&&completed){document.querySelector("textarea")!.value="Draft final speech";return Response.json({id:"session",status:"completed"});}
  return Response.json({id:"session",status:stopped?"processing":"recording"});
 }) as typeof fetch;
 host=document.createElement("div");document.body.append(host);root=createRoot(host);
 await act(async()=>root!.render(<Fixture/>));
 document.querySelector("textarea")!.value="Draft";
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="Start dictation"]')!.click());
 await until(()=>current.phase==="recording");
 document.querySelector<HTMLInputElement>("input")!.focus();
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="End transcription"]')!.click());
 assert.equal(document.activeElement,document.querySelector("textarea"));
 const ending=document.querySelector<HTMLButtonElement>('[aria-label="End transcription"]')!;
 assert.equal(ending.disabled,true);assert.equal(ending.textContent,"Transcribing…");
 await until(()=>stopped===1);
 assert.equal(document.querySelector("textarea")!.value,"Draft");
 completed=true;
 await until(()=>current.phase==="idle");
 assert.equal(stopped,1);assert.equal(document.querySelector("textarea")!.value,"Draft final speech");
 assert.ok(document.querySelector('[aria-label="Start dictation"]'));
});

test("removing the text field cannot prevent an owned recording from ending",async()=>{
 let stopped=0;
 globalThis.fetch=(async(_url,init)=>{
  if(init?.method==="POST"&&JSON.parse(init.body as string).action==="stop")stopped++;
  return Response.json({id:"session",status:stopped?"completed":"recording"});
 }) as typeof fetch;
 host=document.createElement("div");document.body.append(host);root=createRoot(host);
 await act(async()=>root!.render(<Fixture/>));
 await act(async()=>current.toggle());await until(()=>current.phase==="recording");
 const field=document.querySelector<HTMLTextAreaElement>("textarea")!;
 // Model an input replaced while the recording is still owned by this view.
 Object.defineProperty(field,"isConnected",{get:()=>false});
 await act(async()=>current.stop());await until(()=>current.phase==="idle");
 assert.equal(stopped,1);
});
