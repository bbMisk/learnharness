/**
 * LearnHarness's own dark presentation kit for sandboxed lesson demos.
 *
 * Written for LearnHarness: a compact, unframed look with pill buttons, thin
 * slider tracks with round thumbs, and quiet tab pills. Only the theme tokens
 * and the Bootstrap-style utility names below are a contract with the visual
 * agents (see DEMO_VISUAL_STYLE); everything else may change freely.
 */
export const DEMO_CSS = `
:root{
color-scheme:dark;
--background:#141414;--foreground:#fff;--muted-foreground:rgb(255 255 255/.498);
--border:rgb(255 255 255/.082);--input:color-mix(in oklab,#000 10%,transparent);--ring:rgb(131 195 255/.76);
--card:color-mix(in oklab,var(--foreground) 5%,var(--background));--card-foreground:var(--foreground);
--popover:#2d2d2d;--popover-foreground:var(--foreground);
--primary:#83c3ff;--primary-foreground:#0d0d0d;
--secondary:rgb(54 54 54/.96);--secondary-foreground:var(--foreground);
--muted:rgb(255 255 255/.1);--accent:#0d273f;--accent-foreground:var(--primary);--destructive:#ff8549;
--viz-series-1:var(--primary);--viz-series-2:#f59a56;--viz-series-3:#74d58b;--viz-series-4:#f08fc0;--viz-series-5:#aa91ef;--viz-series-6:#5acbc2;
--lh-selected:#339cff;--lh-text:14px;--lh-text-ui:12px;--lh-text-small:12px;
--lh-sans:ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji";
--lh-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
--lh-control:36px;--lh-pill:9999px;
background:var(--background);
}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;padding:4px 0;background:transparent;color:var(--foreground);font-family:var(--lh-sans);font-size:var(--lh-text);line-height:calc(var(--lh-text)*1.625);font-weight:400;-webkit-font-smoothing:antialiased}
p,h1,h2,h3,h4,h5,h6{margin:0}
h1{font-size:1.5em;line-height:1.3333333}h2{font-size:1.25em;line-height:1.4}h3{font-size:1.125em;line-height:1.5555556}h4{font-size:1em;line-height:1.5}h5,h6{font-size:1em;line-height:calc(var(--lh-text)*1.625)}
h1,h2,h3,h4,h5,h6,b,strong,th{font-weight:600}
a{color:color-mix(in srgb,var(--primary) 80%,var(--foreground));text-decoration:none;text-underline-offset:2px;cursor:pointer}
a:hover,a:focus-visible{text-decoration:underline dashed .5px}
code{padding:1px 6px;border-radius:4px;background:var(--muted);font-family:var(--lh-mono);font-size:.92em;overflow-wrap:anywhere;-webkit-box-decoration-break:clone;box-decoration-break:clone}
pre,pre code{padding:0;background:none;font-family:var(--lh-mono);font-size:12px;line-height:20px}
hr{width:100%;height:1px;margin:6px 0;border:0;background:var(--border)}
svg{display:block;max-width:100%;height:auto}
small,.text-small{font-size:var(--lh-text-small);line-height:16px}
.tabular-nums{font-variant-numeric:tabular-nums}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.viz-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(max(180px,24%),1fr));gap:10px}
.viz-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.viz-controls>.form-label{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:2px 12px;flex:1 1 280px;min-width:min(100%,260px);margin:0}
.viz-controls>.form-label>:is(.form-range,.form-control,.form-select){grid-column:1/-1}
.card{min-width:0;padding:12px;overflow:hidden;overflow-wrap:break-word;border-radius:16px;background:var(--card);color:var(--card-foreground)}
.btn,.nav-link{display:inline-flex;align-items:center;justify-content:center;gap:4px;width:fit-content;max-width:100%;height:fit-content;min-height:var(--lh-control);margin:0;padding:0 12px;border:1px solid transparent;border-radius:var(--lh-pill);background:color-mix(in srgb,var(--foreground) 5%,transparent);color:var(--foreground);font:inherit;font-family:var(--lh-sans);font-size:var(--lh-text-ui);line-height:18px;text-align:center;text-decoration:none;white-space:nowrap;vertical-align:middle;cursor:pointer;user-select:none;-webkit-font-smoothing:inherit}
.btn{border-color:var(--border);background:var(--secondary);color:var(--secondary-foreground)}
.btn:not(:disabled):hover,.btn-ghost:not(:disabled):hover{background:rgb(255 255 255/.08)}
.btn-primary{background:var(--foreground);color:var(--primary-foreground)}
.btn.btn-primary:not(:disabled):hover{background:rgb(255 255 255/.8)}
.btn-ghost{border-color:transparent;background:transparent;color:var(--muted-foreground)}
.btn:not(.btn-primary):is([aria-pressed=true],[aria-selected=true]){border-color:transparent;background:var(--lh-selected);color:var(--primary-foreground)}
.btn:disabled,.nav-link:disabled,.nav-link[aria-disabled=true]{opacity:.4;cursor:not-allowed}
.btn:focus-visible,.nav-link:focus-visible{outline:none;box-shadow:0 0 0 2px var(--ring)}
.nav{display:flex;align-items:center;gap:4px;min-width:0}
.nav-pills .nav-link{min-width:0;border-color:transparent;background:transparent;color:var(--muted-foreground)}
.nav-link:not(:disabled):not([aria-disabled=true]):hover{background:var(--muted)}
.nav-pills .nav-link:is(.active,[aria-selected=true]){background:var(--muted);color:var(--foreground)}
[role=tabpanel][hidden],[hidden]{display:none!important}
.form-label{display:block;margin-bottom:6px;color:var(--foreground)}
.form-control,.form-select{display:block;width:100%;min-height:var(--lh-control);margin:0;color:var(--foreground);font:inherit;font-family:var(--lh-sans);font-size:var(--lh-text-ui);vertical-align:middle;outline:none}
.form-control{height:var(--lh-control);padding:0 10px;border:1px solid var(--input);border-radius:6px;background:color-mix(in srgb,var(--popover) 96%,transparent);line-height:1.4285714}
.form-control::placeholder{color:var(--muted-foreground)}
.form-control:focus-visible{border-color:var(--ring)}
.form-control:disabled{background:rgb(255 255 255/.05);color:var(--muted-foreground);cursor:not-allowed}
textarea.form-control{height:auto;min-height:96px;padding:8px 10px;resize:vertical}
.form-select{appearance:none;height:fit-content;padding:0 32px 0 12px;border:1px solid var(--border);border-radius:var(--lh-pill);background:var(--secondary) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M.8.9 5 5.1 9.2.9' fill='none' stroke='%23fff' stroke-opacity='.5' stroke-width='1.2'/%3E%3C/svg%3E") no-repeat right 13px center/10px 6px;line-height:18px;cursor:default}
.form-select:not(:disabled):hover{background-color:rgb(255 255 255/.08)}
.form-select:focus-visible{box-shadow:0 0 0 2px var(--ring)}
.form-select:disabled{opacity:.4;cursor:not-allowed}
.form-select option{background:var(--popover);color:var(--popover-foreground)}
.form-check{display:flex;align-items:center;gap:6px;min-height:var(--lh-control)}
.form-check-label{color:var(--foreground)}
.form-check-input{appearance:none;position:relative;flex:none;width:16px;height:16px;margin:0;border:1px solid var(--input);background:transparent;color:var(--primary-foreground);font:inherit;vertical-align:middle;transition:background-color .15s,border-color .15s,box-shadow .15s}
.form-check-input[type=checkbox]:not(.form-switch *){color:var(--foreground);border-radius:2px;box-shadow:0 1px 2px -1px rgb(0 0 0/.08)}
.form-check-input[type=checkbox]:checked:not(.form-switch *){background:color-mix(in srgb,var(--popover) 96%,transparent)}
.form-check-input[type=checkbox]:checked:not(.form-switch *)::after{content:"";position:absolute;inset:0;background:var(--foreground);-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.4 6.3 4.9 8.8 9.6 3' fill='none' stroke='%23000' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/12px no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.4 6.3 4.9 8.8 9.6 3' fill='none' stroke='%23000' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/12px no-repeat}
.form-check-input[type=radio]{border:0;border-radius:var(--lh-pill);box-shadow:inset 0 0 0 1px var(--input)}
.form-check-input[type=radio]:checked{box-shadow:none;background:radial-gradient(circle,var(--primary-foreground) 3px,var(--foreground) 3.5px)}
.form-check-input:focus-visible{outline:none;box-shadow:0 0 0 2px var(--ring)}
.form-check-input:disabled{cursor:not-allowed;opacity:.5}
.form-switch .form-check-input{width:32px;height:20px;border:0;border-radius:var(--lh-pill);background:var(--muted);box-shadow:none;transition:background-color .2s ease-out}
.form-switch .form-check-input::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px -1px rgb(0 0 0/.08);transition:transform .2s ease-out}
.form-switch .form-check-input:checked{background:var(--lh-selected)}
.form-switch .form-check-input:checked::after{transform:translateX(12px)}
.form-range{appearance:none;display:block;flex:1;width:100%;height:var(--lh-control);margin:0;padding:0;border:0;border-radius:var(--lh-pill);font:inherit;background:transparent;color:var(--foreground);accent-color:var(--primary);vertical-align:middle;outline:none}
.form-range::-webkit-slider-runnable-track{height:2px;border-radius:var(--lh-pill);background:var(--border)}
.form-range::-webkit-slider-thumb{appearance:none;width:20px;height:20px;margin-top:-9px;border:0;border-radius:50%;background:currentColor;box-shadow:0 1px 2px -1px rgb(0 0 0/.08)}
.form-range::-moz-range-track{height:2px;border-radius:var(--lh-pill);background:var(--border)}
.form-range::-moz-range-thumb{width:20px;height:20px;border:0;border-radius:50%;background:currentColor}
.form-range:focus-visible::-webkit-slider-runnable-track{outline:2px solid var(--ring);outline-offset:9px}
.form-range:focus-visible::-moz-range-thumb{outline:2px solid var(--ring);outline-offset:2px}
.lh-tooltip{position:fixed;top:0;left:0;z-index:50;width:max-content;max-width:min(20rem,var(--lh-tooltip-width,calc(100vw - 10px)),calc(100vw - 10px));max-height:min(var(--lh-tooltip-height,calc(100vh - 10px)),calc(100vh - 10px));padding:5px 12px;border:1px solid rgb(255 255 255/.05);border-radius:16px;background:var(--popover);color:var(--popover-foreground);box-shadow:0 8px 18px rgb(15 23 42/.2);font-family:var(--lh-sans);font-size:var(--lh-text-ui);font-weight:600;line-height:18px;letter-spacing:-.15px;text-align:center;white-space:normal;overflow-wrap:break-word;pointer-events:none;user-select:none}
svg.lucide{display:block;flex:none;width:16px!important;height:16px!important;margin:0!important;stroke-width:1.6}
@media (pointer:coarse){
.btn,.nav-link,.form-control,.form-select{min-width:44px;min-height:44px}
.form-control,.form-select{font-size:16px}
.form-check{min-height:44px}
.form-range{height:44px;touch-action:pan-y}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

/**
 * Shared behaviour for demo documents, written for LearnHarness: accessible
 * tabs, data-tooltip popups (positioned with Floating UI when present) and
 * data-lucide icons (when lucide is present). Elements added later are
 * picked up by a MutationObserver.
 */
export const DEMO_CONTROLS = `(()=>{
const g=globalThis,doc=g.document;
if(!doc)return;
const DISABLED=':disabled,[aria-disabled="true"]';
const tabsOf=list=>[...list.querySelectorAll('[role=tab]')].filter(t=>t.closest('[role=tablist]')===list);
const selectTab=(list,tab)=>{
 for(const t of tabsOf(list)){
  const on=t===tab;
  t.setAttribute('aria-selected',String(on));
  t.tabIndex=on?0:-1;
  if(t.classList)t.classList.toggle('active',on);
  const id=t.getAttribute('aria-controls');
  const panel=id&&doc.getElementById(id);
  if(panel){panel.hidden=!on;if(on&&t.id)panel.setAttribute('aria-labelledby',t.id)}
 }
};
const seenLists=new WeakSet();
const setupTabs=root=>{
 const lists=root.matches&&root.matches('[role=tablist]')?[root]:[...root.querySelectorAll('[role=tablist]')];
 for(const list of lists){
  if(seenLists.has(list))continue;
  const tabs=tabsOf(list);
  if(!tabs.length)continue;
  seenLists.add(list);
  const usable=tabs.filter(t=>!t.matches(DISABLED));
  const chosen=tabs.find(t=>t.getAttribute('aria-selected')==='true')||tabs.find(t=>t.classList&&t.classList.contains('active'))||usable[0]||tabs[0];
  selectTab(list,chosen);
 }
};
doc.addEventListener('click',e=>{
 const tab=e.target&&e.target.closest&&e.target.closest('[role=tab]');
 const list=tab&&tab.closest('[role=tablist]');
 if(!list||e.defaultPrevented||tab.matches(DISABLED))return;
 selectTab(list,tab);
});
doc.addEventListener('keydown',e=>{
 const tab=e.target&&e.target.closest&&e.target.closest('[role=tab]');
 const list=tab&&tab.closest('[role=tablist]');
 if(!list||e.defaultPrevented)return;
 const tabs=tabsOf(list).filter(t=>!t.matches(DISABLED));
 const i=tabs.indexOf(tab);
 if(i<0)return;
 const step={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1}[e.key];
 const n=step?(i+step+tabs.length)%tabs.length:e.key==='Home'?0:e.key==='End'?tabs.length-1:-1;
 if(n<0)return;
 e.preventDefault();
 tabs[n].focus();
 selectTab(list,tabs[n]);
});

const ICON_ATTRS={width:16,height:16};
const PENDING='data-lh-icon';
const drawIcons=root=>{
 const lucide=g.lucide;
 if(!lucide||!lucide.createIcons)return;
 const scope=root.querySelectorAll?root:doc;
 const waiting=[...(scope.matches&&scope.matches('[data-lucide]')?[scope]:[]),...scope.querySelectorAll('[data-lucide]')].filter(el=>el.namespaceURI!=='http://www.w3.org/2000/svg');
 if(!waiting.length)return;
 for(const el of waiting)el.setAttribute(PENDING,el.getAttribute('data-lucide'));
 lucide.createIcons({nameAttr:PENDING,attrs:ICON_ATTRS});
 for(const svg of doc.querySelectorAll('svg['+PENDING+']'))svg.removeAttribute(PENDING);
};

const tip=(()=>{
 const F=g.FloatingUIDOM;
 if(!F||!F.computePosition)return null;
 const id='lh-tooltip-'+Math.random().toString(36).slice(2);
 const SIDES=['top','right','bottom','left'];
 const GAP=5,DELAY=700,GRACE=300;
 let box=null,current=null,waiting=null,timer=0,stopTracking=null,graceUntil=0,pinned=false,touched=false,ticket=0;
 const textOf=el=>(el.getAttribute('data-tooltip')||'').trim();
 const triggerOf=e=>{for(const n of e.composedPath?e.composedPath():[e.target]){if(n&&n.nodeType===1){const t=n.closest('[data-tooltip]');if(t)return t}}return null};
 const describe=(el,on)=>{
  const ids=(el.getAttribute('aria-describedby')||'').split(/\\s+/).filter(x=>x&&x!==id);
  if(on)ids.push(id);
  if(ids.length)el.setAttribute('aria-describedby',ids.join(' '));else el.removeAttribute('aria-describedby');
 };
 const cancel=()=>{clearTimeout(timer);timer=0;waiting=null};
 const hide=(grace=true)=>{
  cancel();pinned=false;ticket++;
  if(stopTracking){stopTracking();stopTracking=null}
  if(!current)return;
  describe(current,false);current=null;
  if(box)box.remove();
  if(grace)graceUntil=Date.now()+GRACE;
 };
 const place=el=>{
  const mine=++ticket;
  F.computePosition(el,box,{strategy:'fixed',placement:SIDES.includes(el.getAttribute('data-tooltip-placement'))?el.getAttribute('data-tooltip-placement'):'top',middleware:[F.offset(GAP),F.flip({padding:GAP}),F.shift({padding:GAP}),F.size({padding:GAP,apply({availableWidth,availableHeight,elements}){elements.floating.style.setProperty('--lh-tooltip-width',Math.max(0,availableWidth)+'px');elements.floating.style.setProperty('--lh-tooltip-height',Math.max(0,availableHeight)+'px')}})]})
  .then(({x,y})=>{if(mine!==ticket||current!==el)return;const r=g.devicePixelRatio||1;box.style.transform='translate('+Math.round(x*r)/r+'px,'+Math.round(y*r)/r+'px)';box.style.visibility='visible'})
  .catch(()=>{if(mine===ticket&&current===el)hide(false)});
 };
 const show=el=>{
  const text=textOf(el);
  cancel();
  if(!text||!el.isConnected||current===el)return;
  hide(false);
  if(!box){box=doc.createElement('div');box.id=id;box.className='lh-tooltip';box.setAttribute('role','tooltip')}
  box.textContent=text;box.style.visibility='hidden';box.style.transform='translate(0,0)';
  doc.body.appendChild(box);
  current=el;describe(el,true);
  stopTracking=F.autoUpdate(el,box,()=>place(el));
 };
 const request=(el,now)=>{
  if(!textOf(el)||current===el||waiting===el)return;
  cancel();
  if(now||current||Date.now()<graceUntil){show(el);return}
  waiting=el;timer=setTimeout(()=>{timer=0;waiting=null;show(el)},DELAY);
 };
 const outside=(el,node)=>!(node&&node.nodeType&&el.contains(node));
 doc.addEventListener('pointerover',e=>{if(e.pointerType==='touch')return;const el=triggerOf(e);if(el&&outside(el,e.relatedTarget))request(el,false)});
 doc.addEventListener('pointerout',e=>{if(pinned)return;const el=triggerOf(e);if(el&&outside(el,e.relatedTarget)&&(el===current||el===waiting))hide()});
 doc.addEventListener('focusin',e=>{const el=triggerOf(e);if(el&&el.matches(':focus-visible'))request(el,true)});
 doc.addEventListener('focusout',e=>{if(pinned)return;const el=triggerOf(e);if(el&&outside(el,e.relatedTarget)&&(el===current||el===waiting))hide()});
 doc.addEventListener('pointerdown',e=>{touched=e.pointerType==='touch'});
 doc.addEventListener('pointercancel',()=>{touched=false});
 doc.addEventListener('click',e=>{
  const viaTouch=e.pointerType==='touch'||touched;touched=false;
  if(!viaTouch||e.detail===0)return;
  const el=triggerOf(e);
  if(!el||!textOf(el)||(pinned&&current===el)){if(pinned)hide();return}
  show(el);pinned=current===el;
 });
 doc.addEventListener('keydown',e=>{if(e.key==='Escape')hide()});
 doc.addEventListener('contextmenu',e=>{touched=false;const el=triggerOf(e);if(el&&(el===current||el===waiting))hide()});
 g.addEventListener&&g.addEventListener('pagehide',()=>hide(false),{once:true});
 return {sweep:()=>{if(current&&!current.isConnected)hide(false)}};
})();

// Tooltip targets on plain spans or SVG marks must be reachable with Tab.
const focusTips=root=>{const all=root.querySelectorAll?[...root.querySelectorAll('[data-tooltip]')]:[];if(root.matches&&root.matches('[data-tooltip]'))all.push(root);for(const el of all)if(!el.hasAttribute('tabindex'))el.setAttribute('tabindex','0')};
const enhance=root=>{setupTabs(root);drawIcons(root);focusTips(root)};
enhance(doc);
if(g.MutationObserver&&doc.body)new g.MutationObserver(records=>{
 for(const r of records)for(const n of r.addedNodes)if(n.nodeType===1&&n.isConnected)enhance(n);
 if(tip)tip.sweep();
}).observe(doc.body,{childList:true,subtree:true});
})();`;
