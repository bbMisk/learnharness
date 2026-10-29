import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { buildDemoDocument, DEMO_BRIDGE_SCRIPT } from "../src/core/demo-document.ts";

const fragment='<div id="plot"><button class="btn" data-tooltip="A detail">Try</button></div><script>window.exampleValue=42;</script>';

describe("shared visualization renderer", () => {
 it("keeps legacy documents on the original bridge without restyling", () => {
  const legacy='<!doctype html><html><body><p>Original</p></body></html>';
  assert.equal(buildDemoDocument(legacy),legacy.replace('</body>',DEMO_BRIDGE_SCRIPT+'</body>'));
 });
 it("wraps fragments and complete documents once with a native dark kit", () => {
  for(const html of [fragment,'<!doctype html><html><head><title>Plot</title></head><body>'+fragment+'</body></html>']) {
   const doc=buildDemoDocument(html,'learnharness-v1');
   assert.equal((doc.match(/<html\b/g)||[]).length,1);
   assert.equal((doc.match(/name="learnharness-visualize"/g)||[]).length,1);
   assert.match(doc,/color-scheme:dark/);
   assert.match(doc,/\.form-range/);
   assert.match(doc,/role=tablist/);
   assert.ok(doc.indexOf('learnharness-visualize')<doc.indexOf('window.exampleValue'));
   assert.ok(doc.includes(fragment));
  }
 });
 it("bundles runtime dependencies offline and exposes only presentation state", () => {
  const doc=buildDemoDocument(fragment,'learnharness-v1');
  assert.doesNotMatch(doc,/<script\b[^>]*\bsrc=/i);
  assert.doesNotMatch(doc,/<link\b[^>]*\bhref=/i);
  assert.match(doc,/d3/);assert.doesNotMatch(doc,/FloatingUIDOM|codex-visualization-tabs/);
  assert.match(doc,/setWidgetState/);assert.doesNotMatch(doc,/sendFollowUpMessage/);
 });
 it("preserves valid JavaScript while embedding the bundled libraries", () => {
  const doc=buildDemoDocument(fragment,'learnharness-v1');
  let count=0;
  for(const match of doc.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
   assert.doesNotThrow(()=>new Script(match[1]!));count++;
  }
  assert.ok(count>=5,'helpers and application scripts are embedded');
 });
});

it("embeds full D3 permission notices in exported demo documents",()=>{
 const html=buildDemoDocument(fragment,"learnharness-v1");
 assert.match(html,/Permission to use, copy, modify, and\/or distribute/);
 assert.match(html,/Copyright 2010-2023 Mike Bostock/);
});

it("initializes controls inserted after the demo starts", async()=>{
 const {parseHTML}=await import("linkedom");
 const {runInNewContext}=await import("node:vm");
 const {DEMO_CONTROLS}=await import("../src/core/demo-style.ts");
 const {document,window}=parseHTML("<html><body><main></main></body></html>");
 runInNewContext(DEMO_CONTROLS,{document,MutationObserver:window.MutationObserver});
 const mount=document.querySelector("main")!;
 mount.innerHTML='<div role="tablist"><button role="tab" aria-controls="one" data-tooltip="First">One</button><button role="tab" aria-controls="two">Two</button></div><div id="one">First panel</div><div id="two">Second panel</div>';
 await new Promise(resolve=>setImmediate(resolve));
 const tabs=mount.querySelectorAll<HTMLButtonElement>('[role=tab]');
 assert.equal(tabs[0]!.title,"First");
 assert.equal(document.getElementById("two")!.hidden,true);
 tabs[1]!.click();
 assert.equal(tabs[1]!.getAttribute("aria-selected"),"true");
 assert.equal(document.getElementById("one")!.hidden,true);
 assert.equal(document.getElementById("two")!.hidden,false);
});
