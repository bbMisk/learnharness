import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSameNode } from "./helpers/same-node.ts";
import { readFileSync } from "node:fs";
import { Script, runInNewContext } from "node:vm";
import { buildDemoDocument, DEMO_BRIDGE_SCRIPT, loadDemoRuntimes, peekDemoRuntimes, renderDemoDocument, type DemoRenderer } from "../src/core/demo-document.ts";
import { DEMO_CONTROLS, DEMO_CSS } from "../src/core/demo-style.ts";
import { D3_RUNTIME } from "../src/core/vendor/d3-v7.ts";
import { FLOATING_UI_RUNTIME } from "../src/core/vendor/floating-ui-v1.ts";
import { LUCIDE_RUNTIME } from "../src/core/vendor/lucide-v1.ts";

const fragment = '<div id="plot"><button class="btn" data-tooltip="A detail">Try</button></div><script>window.exampleValue=42;</script>';
const iconFragment = '<div id="plot"><button class="btn"><i data-lucide="play"></i>Play</button></div>';

// Each test file runs in its own process, so nothing has loaded the lazy runtime chunks yet.
const kitBeforeLoad = peekDemoRuntimes(fragment, "learnharness-v1");
const runtimes = await loadDemoRuntimes(iconFragment, "learnharness-v1");
const build = (html: string, renderer?: DemoRenderer) => buildDemoDocument(html, renderer, runtimes);

describe("lazily loaded runtimes", () => {
	it("load on demand: legacy demos need none, kit demos wait for the vendored chunk", async () => {
		assert.equal(kitBeforeLoad, undefined);
		assert.deepEqual(peekDemoRuntimes("<p>legacy</p>"), {});
		assert.throws(() => buildDemoDocument(fragment, "learnharness-v1"), /not loaded/);
		assert.throws(() => buildDemoDocument(iconFragment, "learnharness-v1", { d3: D3_RUNTIME, floatingUi: FLOATING_UI_RUNTIME }), /lucide runtime is not loaded/);
		assert.equal(peekDemoRuntimes(fragment, "visualize-v1"), peekDemoRuntimes(iconFragment, "learnharness-v1"), "one stable object per need");
		assert.equal(await loadDemoRuntimes(fragment, "learnharness-v1"), peekDemoRuntimes(fragment, "learnharness-v1"));
	});
	it("inline the vendored constants verbatim, identically on every path and renderer", async () => {
		assert.deepEqual({ ...runtimes }, { d3: D3_RUNTIME, floatingUi: FLOATING_UI_RUNTIME, lucide: LUCIDE_RUNTIME });
		const shapes = [
			fragment,
			iconFragment,
			"<!doctype html><html><head><title>t</title></head><body><i data-lucide=x></i></body></html>",
			"<html lang=en><body>$& $1 $$</body></html>",
			"<p>no body</p>",
			"",
		];
		for (const html of shapes)
			for (const renderer of [undefined, "learnharness-v1", "visualize-v1"] as const) {
				const doc = build(html, renderer);
				assert.equal(await renderDemoDocument(html, renderer), doc);
				assert.equal(buildDemoDocument(html, renderer, { d3: D3_RUNTIME, floatingUi: FLOATING_UI_RUNTIME, lucide: LUCIDE_RUNTIME }), doc);
				if (renderer) {
					assert.ok(doc.includes(D3_RUNTIME) && doc.includes(FLOATING_UI_RUNTIME));
					assert.equal(doc.includes(LUCIDE_RUNTIME), /lucide/i.test(html));
				} else assert.equal(doc, buildDemoDocument(html), "legacy documents need no runtimes");
			}
	});
});

describe("shared visualization renderer", () => {
	it("keeps legacy documents on the original bridge without restyling", () => {
		const legacy = "<!doctype html><html><body><p>Original</p></body></html>";
		assert.equal(buildDemoDocument(legacy), legacy.replace("</body>", DEMO_BRIDGE_SCRIPT + "</body>"));
	});
	it("wraps fragments and complete documents once with a native dark kit", () => {
		for (const html of [fragment, "<!doctype html><html><head><title>Plot</title></head><body>" + fragment + "</body></html>"]) {
			const doc = build(html, "learnharness-v1");
			assert.equal((doc.match(/<html\b/g) || []).length, 1);
			assert.equal((doc.match(/name="learnharness-visualize"/g) || []).length, 1);
			assert.match(doc, /color-scheme:dark/);
			assert.match(doc, /\.form-range/);
			assert.match(doc, /role=tablist/);
			assert.ok(doc.indexOf("learnharness-visualize") < doc.indexOf("window.exampleValue"));
			assert.ok(doc.includes(fragment));
		}
	});
	it("renders saved visualize-v1 demos with the same kit as new ones", () => {
		assert.equal(build(fragment, "visualize-v1"), build(fragment, "learnharness-v1"));
	});
	it("bundles runtime dependencies offline and exposes only presentation state", () => {
		const doc = build(fragment, "learnharness-v1");
		assert.doesNotMatch(doc, /<script\b[^>]*\bsrc=/i);
		assert.doesNotMatch(doc, /<link\b[^>]*\bhref=/i);
		assert.match(doc, /d3/);
		assert.match(doc, /FloatingUIDOM/);
		assert.match(doc, /setWidgetState/);
		assert.doesNotMatch(doc, /sendFollowUpMessage/);
	});
	it("preserves valid JavaScript while embedding the bundled libraries", () => {
		for (const html of [fragment, iconFragment]) {
			const doc = build(html, "learnharness-v1");
			let count = 0;
			for (const match of doc.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
				assert.doesNotThrow(() => new Script(match[1]!));
				count++;
			}
			assert.ok(count >= 6, "helpers and application scripts are embedded");
		}
	});
	it("includes the theme tokens and utilities the visual agents are promised", () => {
		const doc = build(fragment, "learnharness-v1");
		for (const token of ["--background", "--foreground", "--muted-foreground", "--border", "--popover", "--popover-foreground"])
			assert.match(doc, new RegExp(token + ":"));
		for (let i = 1; i <= 6; i++) assert.match(doc, new RegExp(`--viz-series-${i}:`));
		for (const cls of [
			"viz-row",
			"viz-grid",
			"viz-controls",
			"btn",
			"btn-primary",
			"btn-ghost",
			"form-label",
			"form-range",
			"form-control",
			"form-select",
			"form-check",
			"tabular-nums",
			"text-small",
			"card",
			"nav-pills",
			"nav-link",
		])
			assert.match(DEMO_CSS, new RegExp(`\\.${cls}[^-\\w]`), cls);
	});
	it("adds lucide only to demos that use icons", () => {
		assert.doesNotMatch(build(fragment, "learnharness-v1"), /@license lucide/);
		const doc = build(iconFragment, "learnharness-v1");
		assert.equal((doc.match(/@license lucide v1\.17\.0/g) || []).length, 1);
		assert.ok(doc.indexOf("@license lucide") < doc.indexOf('data-lucide="play"'), "icons load before the demo body");
	});
	it("contains no proprietary Visualize assets", () => {
		const markers = [
			/codex-visualization/i,
			/Codex Visualize/i,
			/visualize\.(css|html)/i,
			/openai\/openai/i,
			/viz-carousel/,
			/visualize-paint-gutter/,
			/-apple-system-body/,
			/corner-shape/,
			/--color-background-primary/,
			/--font-text-md-size/,
			/Agent-facing contract/,
		];
		for (const html of [fragment, iconFragment]) {
			const doc = build(html, "visualize-v1");
			for (const marker of markers) assert.doesNotMatch(doc, marker);
		}
		const manifest = readFileSync(new URL("../src/core/vendor/demo-libraries.json", import.meta.url), "utf8");
		assert.doesNotMatch(manifest, /visualize/i);
	});
});

it("embeds full D3 permission notices in exported demo documents", () => {
	const html = build(fragment, "learnharness-v1");
	assert.match(html, /Permission to use, copy, modify, and\/or distribute/);
	assert.match(html, /Copyright 2010-2023 Mike Bostock/);
});

it("embeds the full Floating UI and lucide license notices", () => {
	assert.equal((FLOATING_UI_RUNTIME.match(/Copyright \(c\) 2021-present Floating UI contributors/g) || []).length, 2);
	assert.match(FLOATING_UI_RUNTIME, /@floating-ui\/core 1\.7\.3[\s\S]*@floating-ui\/dom 1\.7\.4/);
	assert.match(LUCIDE_RUNTIME, /@license lucide v1\.17\.0 - ISC/);
	assert.match(LUCIDE_RUNTIME, /Copyright \(c\) 2026 Lucide Icons and Contributors/);
	assert.match(LUCIDE_RUNTIME, /Copyright \(c\) 2013-present Cole Bemis/);
	assert.doesNotMatch(LUCIDE_RUNTIME, /sourceMappingURL/);
});

async function demoWindow(body: string, extra: Record<string, unknown> = {}) {
	const { parseHTML } = await import("linkedom");
	const { document, window } = parseHTML(`<html><body>${body}</body></html>`);
	const context = {
		document,
		window,
		MutationObserver: window.MutationObserver,
		setTimeout,
		clearTimeout,
		Date,
		Math,
		Promise,
		...extra,
	};
	(context as Record<string, unknown>).globalThis = context;
	return { document, window, context };
}

it("initializes tabs, including ones inserted after the demo starts", async () => {
	const { document, context } = await demoWindow("<main></main>");
	runInNewContext(DEMO_CONTROLS, context);
	const mount = document.querySelector("main")!;
	mount.innerHTML =
		'<div class="nav nav-pills" role="tablist"><button class="nav-link" id="a" role="tab" aria-controls="one" data-tooltip="First">One</button><button class="nav-link" id="b" role="tab" aria-controls="two">Two</button></div><div id="one" role="tabpanel">First panel</div><div id="two" role="tabpanel">Second panel</div>';
	await new Promise((resolve) => setImmediate(resolve));
	const tabs = mount.querySelectorAll<HTMLButtonElement>("[role=tab]");
	assert.equal(tabs[0]!.title, "", "data-tooltip uses the shared popup, not a native title");
	assert.equal(tabs[0]!.classList.contains("active"), true);
	assert.equal(document.getElementById("two")!.hidden, true);
	tabs[1]!.click();
	assert.equal(tabs[1]!.getAttribute("aria-selected"), "true");
	assert.equal(tabs[1]!.classList.contains("active"), true);
	assert.equal(tabs[0]!.classList.contains("active"), false);
	assert.equal(document.getElementById("one")!.hidden, true);
	assert.equal(document.getElementById("two")!.hidden, false);
	assert.equal(document.getElementById("two")!.getAttribute("aria-labelledby"), "b");
});

it("draws lucide icons at 16px, including icons inserted later", async () => {
	const { document, window, context } = await demoWindow('<button><i data-lucide="play"></i>Play</button><div id="later"></div>');
	runInNewContext(LUCIDE_RUNTIME, context);
	assert.ok((context as { lucide?: unknown }).lucide, "lucide UMD registers a global");
	runInNewContext(DEMO_CONTROLS, context);
	const first = document.querySelector("button svg")!;
	assert.match(first.getAttribute("class")!, /lucide lucide-play/);
	assert.equal(first.getAttribute("width"), "16");
	assert.equal(first.getAttribute("data-lucide"), "play");
	assert.equal(first.hasAttribute("data-lh-icon"), false);
	document.getElementById("later")!.innerHTML = '<i data-lucide="info"></i>';
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(document.querySelector("#later svg")?.getAttribute("class") ?? "", /lucide-info/);
	assert.equal(document.querySelectorAll("svg.lucide").length, 2);
	void window;
});

it("opens data-tooltip popups on touch, links them for screen readers and closes on Escape", async () => {
	const placed: unknown[] = [];
	const floating = {
		computePosition: async () => ({ x: 12.3, y: 45.6 }),
		autoUpdate: (_ref: unknown, _el: unknown, update: () => void) => {
			update();
			return () => placed.push("stopped");
		},
		offset: () => ({}),
		flip: () => ({}),
		shift: () => ({}),
		size: () => ({}),
	};
	const { document, window, context } = await demoWindow('<button id="t" data-tooltip="Mass: 2 kg">m</button>', {
		FloatingUIDOM: floating,
	});
	runInNewContext(DEMO_CONTROLS, context);
	const trigger = document.getElementById("t")!;
	const down = new window.Event("pointerdown", { bubbles: true });
	Object.defineProperty(down, "pointerType", { value: "touch" });
	trigger.dispatchEvent(down);
	const click = new window.Event("click", { bubbles: true });
	Object.defineProperty(click, "detail", { value: 1 });
	trigger.dispatchEvent(click);
	const tip = document.querySelector(".lh-tooltip")!;
	assert.ok(tip, "tooltip element is attached");
	assert.equal(tip.textContent, "Mass: 2 kg");
	assert.equal(tip.getAttribute("role"), "tooltip");
	assert.equal(trigger.getAttribute("aria-describedby"), tip.id);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal((tip as HTMLElement).style.visibility, "visible");
	const esc = new window.Event("keydown", { bubbles: true });
	Object.defineProperty(esc, "key", { value: "Escape" });
	document.dispatchEvent(esc);
	assertSameNode(document.querySelector(".lh-tooltip"), null);
	assert.equal(trigger.hasAttribute("aria-describedby"), false);
	assert.deepEqual(placed, ["stopped"]);
});

it("makes data-tooltip targets keyboard-focusable, including ones inserted later", async () => {
	const { document, context } = await demoWindow('<span id="a" data-tooltip="Mass">m</span><span id="b" data-tooltip="Skip" tabindex="-1">s</span><div id="later"></div>');
	runInNewContext(DEMO_CONTROLS, context);
	assert.equal(document.getElementById("a")!.getAttribute("tabindex"), "0");
	assert.equal(document.getElementById("b")!.getAttribute("tabindex"), "-1", "an author's tabindex is kept");
	document.getElementById("later")!.innerHTML = '<svg><circle id="c" data-tooltip="Point"></circle></svg>';
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(document.getElementById("c")!.getAttribute("tabindex"), "0");
});
