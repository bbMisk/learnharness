/** LearnHarness's own dark presentation styles for sandboxed lesson demos. */
export const DEMO_CSS = `
:root{color-scheme:dark;--background:#141414;--foreground:#ededed;--muted-foreground:#aaa;--border:#3b3b3b;--popover:#262626;--popover-foreground:#ededed;--viz-series-1:#82b4ff;--viz-series-2:#eda265;--viz-series-3:#80cf9a;--viz-series-4:#cf98ca;--viz-series-5:#b3a0eb;--viz-series-6:#70c8cd}
*{box-sizing:border-box}body{margin:0;padding:4px 0;background:transparent;color:var(--foreground);font:14px/1.5 system-ui,sans-serif}svg,canvas{max-width:100%}button,input,select{font:inherit;accent-color:var(--viz-series-1)}button,select,input:not([type=range]):not([type=checkbox]){color:inherit;background:#242424;border:1px solid var(--border);border-radius:6px;padding:6px 10px}button{cursor:pointer}button:hover{background:#303030}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--viz-series-1);outline-offset:2px}button:disabled{opacity:.5;cursor:default}.btn-primary,[role=tab][aria-selected=true]{border-color:var(--viz-series-1);background:#23324a}.btn-ghost{background:transparent}.viz-row,.viz-controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px}.form-label{display:grid;grid-template-columns:1fr auto;gap:4px 12px;min-width:min(100%,180px);flex:1}.form-label input[type=range]{grid-column:1/-1;width:100%;margin:4px 0}.form-range{width:100%}.form-check{display:inline-flex;gap:6px;align-items:center}.tabular-nums,output{font-variant-numeric:tabular-nums}.text-small{font-size:12px;color:var(--muted-foreground)}.card{padding:12px;border:1px solid var(--border);border-radius:8px}.nav{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}[hidden]{display:none!important}text{fill:currentColor}.domain,.tick line{stroke:var(--border)}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

/** Native title tooltips and standard ARIA tabs need no third-party runtime. */
export const DEMO_CONTROLS = `(()=>{
const initialized=new WeakSet();
const tabs=list=>[...list.querySelectorAll('[role=tab]')];
const select=(list,tab)=>tabs(list).forEach(t=>{const selected=t===tab;t.setAttribute('aria-selected',String(selected));t.tabIndex=selected?0:-1;const panel=document.getElementById(t.getAttribute('aria-controls'));if(panel)panel.hidden=!selected});
function enhance(root){
 root.querySelectorAll('[data-tooltip]').forEach(el=>{el.title=el.dataset.tooltip;if(!el.hasAttribute('tabindex'))el.tabIndex=0});
 root.querySelectorAll('[role=tablist]').forEach(list=>{if(initialized.has(list))return;initialized.add(list);const items=tabs(list);if(items.length)select(list,items.find(t=>t.getAttribute('aria-selected')==='true')||items[0])});
}
document.addEventListener('click',e=>{const tab=e.target.closest('[role=tab]'),list=tab?.closest('[role=tablist]');if(list)select(list,tab)});
document.addEventListener('keydown',e=>{const list=e.target.closest('[role=tablist]');if(!list)return;const items=tabs(list),i=items.indexOf(e.target);if(i<0)return;let n;if(e.key==='ArrowRight')n=(i+1)%items.length;if(e.key==='ArrowLeft')n=(i+items.length-1)%items.length;if(e.key==='Home')n=0;if(e.key==='End')n=items.length-1;if(n!==undefined){e.preventDefault();select(list,items[n]);items[n].focus()}});
enhance(document);
new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1)enhance(node.parentElement||node)}).observe(document.body,{childList:true,subtree:true});
})();`;
