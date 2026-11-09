import { DEMO_CSS, DEMO_CONTROLS } from "./demo-style.ts";

export type DemoRenderer = "learnharness-v1" | "visualize-v1";

export const DEMO_BRIDGE_SCRIPT =
	'<script>(function(){\nvar send=function(m){try{parent.postMessage(m,"*")}catch(e){}};\nvar post=function(){\nvar b=document.body;\nif(!b){send({type:"demo-resize",height:document.documentElement.scrollHeight});return}\nvar h=Math.max(b.scrollHeight,b.getBoundingClientRect().height);\nvar cs=getComputedStyle(b);\nh+=(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0);\nsend({type:"demo-resize",height:Math.ceil(h)})\n};\nif(typeof ResizeObserver!=="undefined"){new ResizeObserver(post).observe(document.documentElement)}\nwindow.addEventListener("resize",post);\nwindow.addEventListener("load",post);\nwindow.addEventListener("error",function(e){send({type:"demo-error",message:e.message||String(e)})});\nwindow.addEventListener("keydown",function(e){if(e.key==="Escape"&&!e.defaultPrevented&&!e.isComposing)send({type:"demo-escape"})});\nsetTimeout(post,50);\nsetTimeout(post,400);\n})();</script>';

const VISUALIZE_BRIDGE_SCRIPT =
	'<script>(function(){var pending=0,lastHeight=-1;var send=function(m){try{parent.postMessage(m,"*")}catch(e){}};var post=function(){pending=0;var b=document.body;if(!b)return;var cs=getComputedStyle(b);var h=Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height)+(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0));if(h!==lastHeight){lastHeight=h;send({type:"demo-resize",height:h})}};var schedule=function(){if(!pending)pending=requestAnimationFrame(post)};if(typeof ResizeObserver!=="undefined")new ResizeObserver(schedule).observe(document.body);window.addEventListener("resize",schedule);window.addEventListener("load",schedule);window.addEventListener("error",function(e){send({type:"demo-error",message:e.message||String(e)})});window.addEventListener("keydown",function(e){if(e.key==="Escape"&&!e.defaultPrevented&&!e.isComposing)send({type:"demo-escape"})});schedule();setTimeout(schedule,50);setTimeout(schedule,400);})();</script>';

// Presentation state only: no follow-up or model-send API.
const LOCAL_STATE =
	"<script>(()=>{let state=null;window.openai={widgetState:state,setWidgetState:async(next)=>{const value=typeof next==='function'?next(state):next;const json=JSON.stringify(value);if(typeof json!=='string'||new TextEncoder().encode(json).length>16384)throw new Error('Visualization state is too large');state=JSON.parse(json);window.openai.widgetState=state;window.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:state}}}));}};})();</script>";

function script(source: string): string {
	return "<script>" + source.replace(/<\/script/gi, "<\\/script") + "</script>";
}

/**
 * The vendored libraries a kit document inlines (d3 + Floating UI ~340 KB,
 * lucide ~430 KB). They are NOT imported statically: this module rides the
 * core barrel into every page's first-load JS, so the runtimes arrive via
 * loadDemoRuntimes — dynamic imports the bundler splits into chunks fetched
 * only when a demo actually renders. Documents stay self-contained: the
 * strings are still inlined, never referenced by <script src>.
 */
export interface DemoRuntimes {
	d3?: string;
	floatingUi?: string;
	lucide?: string;
}

const NO_RUNTIMES: DemoRuntimes = Object.freeze({});

/** What a document needs beyond the bridge: legacy demos nothing, kit demos d3 + Floating UI, plus lucide when they mention it. */
function runtimeNeeds(html: string, renderer?: DemoRenderer): "none" | "kit" | "icons" {
	if (renderer !== "learnharness-v1" && renderer !== "visualize-v1") return "none";
	// lucide is ~400 KB, so it rides along only when the demo mentions it (data-lucide or window.lucide).
	return /lucide/i.test(html) ? "icons" : "kit";
}

// Loaded once per process/tab; a failed load is forgotten so the next render retries.
let kitLoad: Promise<DemoRuntimes> | undefined;
let iconsLoad: Promise<DemoRuntimes> | undefined;
let kitLoaded: DemoRuntimes | undefined;
let iconsLoaded: DemoRuntimes | undefined;

function loadKit(): Promise<DemoRuntimes> {
	kitLoad ??= Promise.all([import("./vendor/d3-v7.ts"), import("./vendor/floating-ui-v1.ts")]).then(
		([d3, floating]) => (kitLoaded = Object.freeze({ d3: d3.D3_RUNTIME, floatingUi: floating.FLOATING_UI_RUNTIME })),
		(err: unknown) => {
			kitLoad = undefined;
			throw err;
		},
	);
	return kitLoad;
}

function loadIcons(): Promise<DemoRuntimes> {
	iconsLoad ??= Promise.all([loadKit(), import("./vendor/lucide-v1.ts")]).then(
		([kit, lucide]) => (iconsLoaded = Object.freeze({ ...kit, lucide: lucide.LUCIDE_RUNTIME })),
		(err: unknown) => {
			iconsLoad = undefined;
			throw err;
		},
	);
	return iconsLoad;
}

/** The runtimes `html` needs if they are already loaded (a stable object per need), else undefined. Legacy demos need none. */
export function peekDemoRuntimes(html: string, renderer?: DemoRenderer): DemoRuntimes | undefined {
	const needs = runtimeNeeds(html, renderer);
	return needs === "none" ? NO_RUNTIMES : needs === "kit" ? (iconsLoaded ?? kitLoaded) : iconsLoaded;
}

/** Load (once) the runtimes `html` needs for buildDemoDocument. */
export function loadDemoRuntimes(html: string, renderer?: DemoRenderer): Promise<DemoRuntimes> {
	const ready = peekDemoRuntimes(html, renderer);
	if (ready) return Promise.resolve(ready);
	return runtimeNeeds(html, renderer) === "icons" ? loadIcons() : loadKit();
}

function required(source: string | undefined, name: string): string {
	if (source === undefined) throw new Error(`buildDemoDocument: the ${name} runtime is not loaded (await loadDemoRuntimes first)`);
	return source;
}

/**
 * One renderer for builder verification, lesson display, previews, and
 * exports. Kit renderers need `runtimes` from loadDemoRuntimes (or use
 * renderDemoDocument); legacy demos only get the bridge and need none.
 */
export function buildDemoDocument(html: string, renderer?: DemoRenderer, runtimes: DemoRuntimes = NO_RUNTIMES): string {
	let doc = html;
	let tail = DEMO_BRIDGE_SCRIPT;
	const needs = runtimeNeeds(html, renderer);
	if (needs !== "none") {
		let head =
			'<meta name="learnharness-visualize" content="1">' +
			'<meta name="viewport" content="width=device-width, initial-scale=1">' +
			"<style>" +
			DEMO_CSS +
			"</style>" +
			LOCAL_STATE +
			script(required(runtimes.d3, "d3")) +
			script(required(runtimes.floatingUi, "Floating UI"));
		if (needs === "icons") head += script(required(runtimes.lucide, "lucide"));
		if (/<head\b[^>]*>/i.test(doc)) doc = doc.replace(/<head\b[^>]*>/i, (tag) => tag + head);
		else if (/<html\b[^>]*>/i.test(doc)) doc = doc.replace(/<html\b[^>]*>/i, (tag) => tag + "<head>" + head + "</head>");
		else doc = "<!doctype html><html><head>" + head + "</head><body>" + doc + "</body></html>";
		tail = script(DEMO_CONTROLS) + VISUALIZE_BRIDGE_SCRIPT;
	}
	return /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, () => tail + "</body>") : doc + tail;
}

/** buildDemoDocument after loading whatever runtimes the document needs (server verification, exports). */
export async function renderDemoDocument(html: string, renderer?: DemoRenderer): Promise<string> {
	return buildDemoDocument(html, renderer, await loadDemoRuntimes(html, renderer));
}
