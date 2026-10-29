import { DEMO_CSS, DEMO_CONTROLS } from "./demo-style.ts";
import { D3_RUNTIME } from "./vendor/d3-v7.ts";

export type DemoRenderer = "learnharness-v1" | "visualize-v1";

export const DEMO_BRIDGE_SCRIPT = "<script>(function(){\nvar send=function(m){try{parent.postMessage(m,\"*\")}catch(e){}};\nvar post=function(){\nvar b=document.body;\nif(!b){send({type:\"demo-resize\",height:document.documentElement.scrollHeight});return}\nvar h=Math.max(b.scrollHeight,b.getBoundingClientRect().height);\nvar cs=getComputedStyle(b);\nh+=(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0);\nsend({type:\"demo-resize\",height:Math.ceil(h)})\n};\nif(typeof ResizeObserver!==\"undefined\"){new ResizeObserver(post).observe(document.documentElement)}\nwindow.addEventListener(\"resize\",post);\nwindow.addEventListener(\"load\",post);\nwindow.addEventListener(\"error\",function(e){send({type:\"demo-error\",message:e.message||String(e)})});\nsetTimeout(post,50);\nsetTimeout(post,400);\n})();</script>";

const VISUALIZE_BRIDGE_SCRIPT = "<script>(function(){var pending=0,lastHeight=-1;var send=function(m){try{parent.postMessage(m,\"*\")}catch(e){}};var post=function(){pending=0;var b=document.body;if(!b)return;var cs=getComputedStyle(b);var h=Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height)+(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0));if(h!==lastHeight){lastHeight=h;send({type:\"demo-resize\",height:h})}};var schedule=function(){if(!pending)pending=requestAnimationFrame(post)};if(typeof ResizeObserver!==\"undefined\")new ResizeObserver(schedule).observe(document.body);window.addEventListener(\"resize\",schedule);window.addEventListener(\"load\",schedule);window.addEventListener(\"error\",function(e){send({type:\"demo-error\",message:e.message||String(e)})});schedule();setTimeout(schedule,50);setTimeout(schedule,400);})();</script>";

// Presentation state only: no follow-up or model-send API.
const LOCAL_STATE = "<script>(()=>{let state=null;window.openai={widgetState:state,setWidgetState:async(next)=>{const value=typeof next==='function'?next(state):next;const json=JSON.stringify(value);if(typeof json!=='string'||new TextEncoder().encode(json).length>16384)throw new Error('Visualization state is too large');state=JSON.parse(json);window.openai.widgetState=state;window.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:state}}}));}};})();</script>";

function script(source: string): string {
 return '<script>'+source.replace(/<\/script/gi, '<\\/script')+'</script>';
}

const KIT_HEAD = '<meta name="learnharness-visualize" content="1">'
 + '<meta name="viewport" content="width=device-width, initial-scale=1">'
 + '<style>'+DEMO_CSS+'\n:root{color-scheme:dark;--background:#141414;--font-text-md-size:14px}html>body{padding:4px 0}</style>'
 + LOCAL_STATE + script(D3_RUNTIME);

/** One renderer for builder verification, lesson display, previews, and exports. */
export function buildDemoDocument(html: string, renderer?: DemoRenderer): string {
 let doc=html;
 let tail=DEMO_BRIDGE_SCRIPT;
 if(renderer==='learnharness-v1' || renderer==='visualize-v1') {
  if(/<head\b[^>]*>/i.test(doc)) doc=doc.replace(/<head\b[^>]*>/i, tag=>tag+KIT_HEAD);
  else if(/<html\b[^>]*>/i.test(doc)) doc=doc.replace(/<html\b[^>]*>/i, tag=>tag+'<head>'+KIT_HEAD+'</head>');
  else doc='<!doctype html><html><head>'+KIT_HEAD+'</head><body>'+doc+'</body></html>';
  tail=script(DEMO_CONTROLS)+VISUALIZE_BRIDGE_SCRIPT;
 }
 return /<\/body>/i.test(doc)?doc.replace(/<\/body>/i,()=>tail+'</body>'):doc+tail;
}
