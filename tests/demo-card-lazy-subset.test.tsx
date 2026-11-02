/** A d3-only success must not clear an icon demo's lucide failure (round-4 Codex hunt). */
import React,{act} from 'react';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {registerHooks} from 'node:module';
const dom=parseHTML('<html><body></body></html>');
Object.assign(globalThis,{React,window:dom.window,document:dom.document,Node:dom.window.Node,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,IS_REACT_ACT_ENVIRONMENT:true,self:globalThis});
let release!:()=>void;(globalThis as any).__kitGate=new Promise<void>(r=>release=r);
const hooks=registerHooks({resolve(s,c,next){if(s.endsWith('/vendor/lucide-v1.ts')) throw Error('lucide failed'); if(s.endsWith('/vendor/d3-v7.ts')) return {url:'data:text/javascript,'+encodeURIComponent('await globalThis.__kitGate; export const D3_RUNTIME="stub";'),shortCircuit:true}; return next(s,c)}});
const {createRoot}=await import('react-dom/client');const {DemoOutputCard}=await import('../components/artifacts/demo-card.tsx');
const sleep=(n:number)=>new Promise(r=>setTimeout(r,n));
test('kit success must not clear icon-only failure',async()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const demo=(title:string,html:string)=>({title,html,renderer:'learnharness-v1'});
 await act(async()=>root.render(<><DemoOutputCard output={demo('icons','<i data-lucide="star"></i>')}/><DemoOutputCard output={demo('kit','<p>kit</p>')}/></>));
 for(let i=0;i<30&&!host.querySelector('[data-testid=demo-retry]');i++) await act(async()=>sleep(5));
 assert.equal(host.querySelectorAll('[data-testid=demo-retry]').length,1);
 await act(async()=>{release();await sleep(30)});
 const retry=host.querySelectorAll('[data-testid=demo-retry]').length;const loading=host.querySelector('[data-testid=demo-loading]')?.textContent;
 await act(async()=>root.unmount());host.remove();hooks.deregister();
 assert.equal(retry,1,`icon failure must remain actionable; got ${loading}`);
});
