/** The refresh hook under React <Activity> hide/show while a response lands (round-4 Codex hunt). */
import React,{act,useState,Activity} from 'react';import {test} from 'node:test';import assert from 'node:assert/strict';import {parseHTML} from 'linkedom';
const dom=parseHTML('<!doctype html><html><body></body></html>');Object.assign(globalThis,{React,window:dom.window,document:dom.document,Node:dom.window.Node,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true,self:globalThis});
const {createRoot}=await import('react-dom/client');const {useChatListRefresh}=await import('../components/chat-list-refresh.ts');const {ServerEventsProvider}=await import('../components/server-events.tsx');
test('hook refresh survives Activity hide while response lands',async()=>{
 let resolve!:(r:Response)=>void;let refresh!:()=>Promise<void>;let chats:any=null;let calls=0;const original=globalThis.fetch;
 globalThis.fetch=((url:any)=>{if(String(url)==='/api/chats'){calls++;return calls===1?new Promise<Response>(r=>resolve=r):Promise.resolve(Response.json({chats:[{id:'new'}]}))}return Promise.resolve(Response.json({projects:[]}))}) as typeof fetch;
 const source={close(){},onOpen(_cb:any){},onEvent(_n:any,_cb:any){}};
 function Harness(){const [state,setState]=useState<any>(null);chats=state;refresh=useChatListRefresh({chats:state,setChats:setState,setProjects:()=>{}});return null}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const render=(mode:'visible'|'hidden')=><ServerEventsProvider connect={()=>source}><Activity mode={mode}><Harness/></Activity></ServerEventsProvider>;
 await act(async()=>root.render(render('visible')));let p!:Promise<void>;await act(async()=>{p=refresh()});await act(async()=>root.render(render('hidden')));await act(async()=>{resolve(Response.json({chats:[{id:'new'}]}));await p});await act(async()=>root.render(render('visible')));await act(async()=>new Promise(r=>setTimeout(r,320)));const observed=chats;await act(async()=>root.unmount());host.remove();globalThis.fetch=original;assert.deepEqual(observed,[{id:'new'}]);
});
