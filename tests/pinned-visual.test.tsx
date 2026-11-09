/**
 * The pinned demo or diagram (src/core/pinned-visual.ts,
 * src/agent/tools/pin-visual.ts, components/pinned-visual.tsx): the tutor
 * tool's validation, the pinned item's derivation from the record and the
 * learner's clicks, the hidden tool part, the layout math, the Esc layering,
 * and the card staying the SAME element (no remount, no iframe reload) when
 * it is pinned and unpinned. linkedom; no network.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { assertSameNode } from "./helpers/same-node.ts";
import fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { JobRecord } from "../src/core/contracts/jobs.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { latestTutorPin, pinnedJobId, pinTargetOf, PIN_VISUAL_TOOL } = await import("../src/core/pinned-visual.ts");
const { projectView } = await import("../src/core/view.ts");
const { createViewProjector } = await import("../src/core/view-incremental.ts");
const { sessionMarkdown } = await import("../src/core/session-markdown.ts");
const { pinVisualTool, resolvePinTarget, PIN_VISUAL_DESCRIPTION } = await import("../src/agent/tools/pin-visual.ts");
const { PinnableArtifact, PinnedVisualContext, demoFit, pinMode, DEMO_MIN_SCALE, usePinnedVisual } = await import("../components/pinned-visual.tsx");
const { DemoOutputCard } = await import("../components/artifacts/demo-card.tsx");
const { VisualOutputCard } = await import("../components/artifacts/visual-card.tsx");
const { escAbortTarget } = await import("../components/chat.tsx");

const job = (id: string, kind: JobRecord["kind"], result?: unknown, input?: unknown): JobRecord =>
	({ id, kind, chatId: "c1", toolCallId: `t_${id}`, status: result ? "done" : "running", activity: "", createdAt: "", updatedAt: "", result, input }) as JobRecord;
const DEMO = { title: "The finite-subcover game", html: "<p>demo</p>", tested: true };
// Newest first, like JobStore.listJobs(chatId).
const jobs = [
	job("job_new", "demo", { ...DEMO, html: "<p>v2</p>" }, { title: DEMO.title }),
	job("job_fig", "visual", { svg: "<svg/>" }),
	job("job_old", "demo", DEMO, { title: DEMO.title }),
	job("job_run", "demo", undefined, { title: "Still building" }),
	job("job_bad", "demo", { title: "Broken", html: "", tested: true }),
	job("job_res", "research", { brief: "b", sources: [] }),
];

describe("pin_visual: the tutor tool", () => {
	it("resolves a job id or a demo's exact title (the newest on a repeat); diagrams by id", () => {
		assert.equal((resolvePinTarget(jobs, "job_old") as { job: JobRecord }).job.id, "job_old");
		assert.equal((resolvePinTarget(jobs, " job_fig ") as { job: JobRecord }).job.id, "job_fig");
		assert.equal((resolvePinTarget(jobs, DEMO.title) as { job: JobRecord }).job.id, "job_new", "a repeated title pins the latest version");
	});

	it("unknown, undelivered, failed or non-visual targets fail with what can be pinned", () => {
		for (const [visual, words] of [
			["the subcover demo", /No demo or diagram in this lesson matches "the subcover demo"/],
			["job_res", /No demo or diagram/],
			["job_run", /has not been delivered yet/],
			["Still building", /has not been delivered yet/],
			["job_bad", /failed, so there is nothing to pin/],
		] as const) {
			const found = resolvePinTarget(jobs, visual);
			assert.ok("error" in found, visual);
			assert.match(found.error, words);
			assert.match(found.error, /Pinnable now: job_new \(demo "The finite-subcover game"\), job_fig \(diagram\), job_old/);
		}
		assert.match((resolvePinTarget([], "x") as { error: string }).error, /No demo or diagram has been delivered in this lesson yet/);
	});

	it("execute: an error result the model retries on, or a slim ack whose details name the job", async () => {
		const tool = pinVisualTool({ chatId: "c1", jobStore: { listJobs: (chatId?: string) => (chatId === "c1" ? jobs : []) } as never });
		assert.equal(tool.name, PIN_VISUAL_TOOL);
		assert.equal(
			tool.description,
			"Pin an earlier demo or diagram beside the chat so the learner can use it while reading on. Pass its job id (from the dispatch result) or its exact title. Pinning replaces any demo or diagram already pinned. It has no other effect and does not end your turn.",
		);
		assert.equal(PIN_VISUAL_DESCRIPTION, tool.description);
		const bad = await tool.execute("call1", { visual: "nope" });
		assert.equal(bad.isError, true);
		assert.match((bad.content[0] as { text: string }).text, /Invalid tool input for tool "pin_visual"/);
		const ok = await tool.execute("call2", { visual: DEMO.title });
		assert.notEqual(ok.isError, true);
		assert.equal((ok as { terminate?: boolean }).terminate, undefined, "not a question tool: the turn goes on");
		assert.deepEqual(ok.details, { ok: true, jobId: "job_new" });
	});

	it("the demos fragment carries the approved line", () => {
		const text = fs.readFileSync(new URL("../src/agent/prompts/teacher/50-demos.md", import.meta.url), "utf8");
		assert.ok(text.includes("When you refer back to a demo or diagram shown earlier in the lesson, call pin_visual for it in the same message, so the learner does not have to scroll back to find it."));
	});
});

// ─── the record ──────────────────────────────────────────────────────────────

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (id: string, content: object[]) =>
	({ id, role: "assistant", content, stopReason: "toolUse", usage, provider: "test", model: "test", timestamp: 0 }) as unknown as LhMessage;
const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const result = (toolCallId: string, toolName: string, details: unknown, isError = false) =>
	({ id: `r_${toolCallId}`, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: isError ? "Invalid tool input" : "ok" }], details, isError, timestamp: 0 }) as unknown as LhMessage;
const steer = (jobId: string, kind: "demo" | "visual", res: unknown) =>
	({ id: `steer_${jobId}`, role: "custom", customType: "subagent-steer", content: "delivered", display: true, details: { jobId, kind, toolCallId: `t_${jobId}`, result: res }, timestamp: 0 }) as unknown as LhMessage;

const record: LhMessage[] = [
	{ id: "u1", role: "user", content: "teach me compactness", timestamp: 0 } as never,
	steer("job_a", "demo", DEMO),
	steer("job_f", "visual", { svg: "<svg/>" }),
	assistant("a1", [{ type: "text", text: "In the demo, select K=(0,1]." }, call("p1", PIN_VISUAL_TOOL, { visual: DEMO.title })]),
	result("p1", PIN_VISUAL_TOOL, { ok: true, jobId: "job_a" }),
	// A failed call, then a pin-only message.
	assistant("a2", [call("p2", PIN_VISUAL_TOOL, { visual: "nope" })]),
	result("p2", PIN_VISUAL_TOOL, { tool: PIN_VISUAL_TOOL, problems: ["x"] }, true),
	assistant("a3", [call("p3", PIN_VISUAL_TOOL, { visual: "job_f" })]),
	result("p3", PIN_VISUAL_TOOL, { ok: true, jobId: "job_f" }),
	assistant("a4", [{ type: "text", text: "Look at the figure." }]),
];

describe("the pinned item, derived", () => {
	it("is the latest successful pin_visual call; failures never count", () => {
		assert.deepEqual(latestTutorPin(record), { callId: "p3", jobId: "job_f" });
		assert.deepEqual(latestTutorPin(record.slice(0, 7)), { callId: "p1", jobId: "job_a" });
		assert.equal(latestTutorPin(record.slice(0, 4)), null);
	});

	it("counts a live execution before its result lands, and the settled result after", () => {
		const midTurn = record.slice(0, 8);
		const live = new Map([["p3", { isError: false, output: { ok: true, jobId: "job_f" } }]]);
		assert.deepEqual(latestTutorPin(midTurn, live), { callId: "p3", jobId: "job_f" });
		assert.deepEqual(latestTutorPin(midTurn, new Map([["p3", { isError: true }]])), { callId: "p1", jobId: "job_a" });
	});

	it("the learner's click wins until the tutor pins again", () => {
		const tutor = { callId: "p1", jobId: "job_a" };
		assert.equal(pinnedJobId(tutor, null), "job_a");
		assert.equal(pinnedJobId(null, null), null);
		assert.equal(pinnedJobId(tutor, { afterCall: "p1", jobId: null }), null, "unpinned after the tutor's pin");
		assert.equal(pinnedJobId(tutor, { afterCall: "p1", jobId: "job_f" }), "job_f", "the learner pinned something else");
		assert.equal(pinnedJobId(null, { afterCall: null, jobId: "job_f" }), "job_f", "a pin before any tutor pin");
		assert.equal(pinnedJobId({ callId: "p3", jobId: "job_a" }, { afterCall: "p1", jobId: null }), "job_a", "a newer tutor pin takes over");
	});

	it("targets only a delivered, successful demo or figure card", () => {
		const view = projectView([...record, steer("job_x", "demo", { title: "Broken", html: "", tested: true })]);
		assert.deepEqual(pinTargetOf(view, "job_a"), { jobId: "job_a", kind: "demo", title: DEMO.title });
		assert.deepEqual(pinTargetOf(view, "job_f"), { jobId: "job_f", kind: "visual", title: "Figure" });
		assert.equal(pinTargetOf(view, "job_x"), null, "a failure note is not pinnable");
		assert.equal(pinTargetOf(view, "job_missing"), null);
		assert.equal(pinTargetOf(view, null), null);
	});
});

describe("pin_visual is invisible in the transcript", () => {
	it("no part for a successful call, no row for a pin-only message; a failure is the retry line", () => {
		const view = projectView(record);
		const parts = view.flatMap((m) => m.parts);
		const pins = parts.filter((p) => p.type === `tool-${PIN_VISUAL_TOOL}`);
		assert.deepEqual(pins.map((p) => [p.toolCallId, p.state]), [["p2", "output-error"]], "only the failed call shows (as Retrying…)");
		const group = view.filter((m) => m.role === "assistant");
		assert.equal(group.length, 1, "one assistant group");
		// a1, a2 (the failure), a4 — the successful pin-only a3 adds no step.
		assert.equal(group[0]!.parts.filter((p) => p.type === "step-start").length, 3);
	});

	it("live: hidden while streaming and after a clean end; a failed end shows at once; the incremental projector agrees", () => {
		const streaming = { inFlight: true, streamingIds: new Set(["a3"]), executions: new Map() };
		assert.ok(!projectView(record.slice(0, 8), streaming).flatMap((m) => m.parts).some((p) => p.toolCallId === "p3"));
		const clean = { inFlight: true, streamingIds: new Set<string>(), executions: new Map([["p3", { isError: false, output: { ok: true, jobId: "job_f" } }]]) };
		assert.ok(!projectView(record.slice(0, 8), clean).flatMap((m) => m.parts).some((p) => p.toolCallId === "p3"));
		const failed = { inFlight: true, streamingIds: new Set<string>(), executions: new Map([["p3", { isError: true, errorText: "Invalid tool input" }]]) };
		const part = projectView(record.slice(0, 8), failed).flatMap((m) => m.parts).find((p) => p.toolCallId === "p3");
		assert.equal(part?.state, "output-error");
		for (const live of [undefined, streaming, clean, failed]) {
			const projector = createViewProjector();
			for (let n = 1; n <= record.length; n++) {
				assert.deepStrictEqual(projector.project(record.slice(0, n), live), projectView(record.slice(0, n), live));
			}
		}
	});

	it("the markdown export leaves pins out", () => {
		assert.doesNotMatch(sessionMarkdown(record), /pin_visual/);
	});
});

describe("layout", () => {
	it("docks while the chat keeps 560px beside the panel, else the drawer", () => {
		assert.equal(pinMode(1160, 560), "dock");
		assert.equal(pinMode(1120, 560), "dock");
		assert.equal(pinMode(1119, 560), "drawer");
		assert.equal(pinMode(1000, 560), "drawer");
	});

	it("a demo keeps its width and scales down to fit, never below 0.7; past that it lays out narrower", () => {
		assert.deepEqual(demoFit(700, 700), { layout: 700, scale: 1 });
		assert.deepEqual(demoFit(400, 700), { layout: 700, scale: 1 }, "a narrower card fills the panel");
		const fit = demoFit(800, 600);
		assert.equal(fit.layout, 800);
		assert.equal(fit.scale, 0.75);
		const wide = demoFit(1400, 560);
		assert.equal(wide.scale, DEMO_MIN_SCALE);
		assert.ok(Math.abs(wide.layout * wide.scale - 560) < 1e-6, "fits exactly at the floor");
		// A very narrow panel: the layout floor holds and the panel scrolls sideways.
		const narrow = demoFit(900, 300);
		assert.equal(narrow.scale, DEMO_MIN_SCALE);
		assert.ok(narrow.layout * narrow.scale > 300);
		// A phone: the demo already lays out at 358 in the transcript, so it fits the 318 px drawer.
		const phone = demoFit(358, 318);
		assert.equal(phone.layout, 358);
		assert.ok(Math.abs(phone.layout * phone.scale - 318) < 1e-6, "no sideways scroll");
		assert.equal(demoFit(410, 395).layout, 520, "a tablet's drawer, wide enough for the floor, keeps it");
	});

	it("Esc: an expanded pin closes first; an open drawer closes above a question; a closed one never opens", () => {
		const none = { abortAsk: false, mermaidFocus: false, planOpen: false, setupOpen: false, pending: false, problem: false, busy: false };
		assert.equal(escAbortTarget({ ...none, pinExpanded: true, pending: true, drawer: "open" }), "pin-expanded");
		assert.equal(escAbortTarget({ ...none, mermaidFocus: true, pinExpanded: true }), "mermaid");
		assert.equal(escAbortTarget({ ...none, drawer: "open", pending: true }), "pin-drawer");
		assert.equal(escAbortTarget({ ...none, drawer: "open", planOpen: true }), "plan");
		assert.equal(escAbortTarget({ ...none, drawer: "closed", pending: true }), "question");
		assert.equal(escAbortTarget({ ...none, drawer: "closed", busy: true }), "turn");
		assert.equal(escAbortTarget({ ...none, drawer: "closed" }), null, "Esc never opens UI");
		assert.equal(escAbortTarget({ ...none, drawer: null }), null);
	});
});

// ─── the card stays put (render) ─────────────────────────────────────────────

let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
	if (root) await act(async () => root!.unmount());
	root = null;
	document.body.innerHTML = "";
});

const FRAME = { left: 600, top: 72, width: 536, maxHeight: 700 };

describe("pinning restyles the card in place", () => {
	it("the same iframe element before, while and after pinned; a placeholder holds its row", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		const calls: string[] = [];
		const state = (pinnedId: string | null, extra: object = {}) => ({
			pinnedId,
			frame: pinnedId ? FRAME : null,
			hidden: false,
			expanded: false,
			dragging: false,
			zIndex: 15,
			pin: (id: string) => calls.push(`pin ${id}`),
			unpin: () => calls.push("unpin"),
			setExpanded: (v: boolean) => calls.push(`expand ${v}`),
			...extra,
		});
		const render = (pinnedId: string | null, extra?: object) =>
			act(async () =>
				root!.render(
					<PinnedVisualContext.Provider value={state(pinnedId, extra)}>
						<PinnableArtifact jobId="job_a" kind="demo">
							<DemoOutputCard output={DEMO} />
						</PinnableArtifact>
						<PinnableArtifact jobId="job_f" kind="visual">
							<VisualOutputCard output={{ svg: "<svg width='200' height='100'/>" }} />
						</PinnableArtifact>
					</PinnedVisualContext.Provider>,
				),
			);
		await render(null);
		const iframe = host.querySelector('[data-testid="demo-iframe"]');
		assert.ok(iframe);
		const [demoSlot] = host.querySelectorAll('[data-testid="pin-slot"]');
		assertSameNode(host.querySelector('[data-testid="pin-placeholder"]'), null);
		assert.equal(host.querySelectorAll('[data-testid="pin-toggle"]').length, 2, "both cards offer a pin");
		assertSameNode(host.querySelector('[data-testid="pin-expand"]'), null, "expand only once pinned");

		(host.querySelector('[data-testid="pin-toggle"]') as HTMLElement).click();
		assert.deepEqual(calls, ["pin job_a"]);

		await render("job_a");
		assertSameNode(host.querySelector('[data-testid="demo-iframe"]'), iframe, "no remount: the very same iframe");
		assertSameNode(host.querySelectorAll('[data-testid="pin-slot"]')[0], demoSlot);
		const panel = demoSlot!.querySelector('[data-testid="pin-panel"]') as HTMLElement;
		assert.match(panel.getAttribute("class") ?? "", /\bfixed\b/);
		const style = panel.getAttribute("style") ?? "";
		assert.match(style, /left:\s*600px/);
		assert.match(style, /top:\s*72px/);
		assert.match(style, /width:\s*536px/);
		assert.match(style, /max-height:\s*700px/);
		assert.ok(demoSlot!.querySelector('[data-testid="pin-placeholder"]'), "the row keeps a placeholder");
		assert.match(demoSlot!.querySelector('[data-testid="pin-placeholder"]')!.textContent ?? "", /Pinned beside the chat/);
		assert.match(demoSlot!.getAttribute("style") ?? "", /height:/, "of a fixed height");
		assert.ok(host.querySelector('[data-testid="pin-expand"]'), "a pinned demo can expand");
		const figurePanel = host.querySelectorAll('[data-testid="pin-panel"]')[1] as HTMLElement;
		assert.doesNotMatch(figurePanel.getAttribute("class") ?? "", /fixed/, "only one card is pinned");

		await render("job_a", { hidden: true });
		assertSameNode(host.querySelector('[data-testid="demo-iframe"]'), iframe, "a collapsed drawer hides, never unmounts");
		assert.match(panel.getAttribute("style") ?? "", /visibility:\s*hidden/);
		assert.match(demoSlot!.querySelector('[data-testid="pin-placeholder"]')!.textContent ?? "", /Pinned in the side drawer/, "a closed drawer isn't beside the chat");

		await render("job_f");
		assertSameNode(host.querySelector('[data-testid="demo-iframe"]'), iframe, "unpinned: back in its row, same element");
		assert.doesNotMatch(panel.getAttribute("class") ?? "", /fixed/);
		// (linkedom keeps the cleared declarations as empty ones.)
		assert.doesNotMatch(panel.getAttribute("style") ?? "", /:\s*[^;\s]/, "no position left on it");
		assert.match(figurePanel.getAttribute("class") ?? "", /\bfixed\b/, "pinning another replaces it");
		const img = figurePanel.querySelector("img")!;
		assert.match(img.getAttribute("class") ?? "", /max-h-\[var\(--lh-pin-h\)\]/, "the figure fits the panel's height");
	});

	it("outside a chat page (no pin context) a card renders exactly as before, with no pin button", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<PinnableArtifact jobId="job_a" kind="demo"><DemoOutputCard output={DEMO} /></PinnableArtifact>));
		assertSameNode(host.querySelector('[data-testid="pin-toggle"]'), null);
		assert.ok(host.querySelector('[data-testid="demo-iframe"]'));
	});
});

describe("an expanded demo is a modal", () => {
	it("the expanded panel carries data-lh-modal; docked or in a drawer it does not", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		const state = (expanded: boolean) => ({
			pinnedId: "job_a", frame: FRAME, hidden: false, expanded, dragging: false, zIndex: expanded ? 40 : 15,
			pin: () => {}, unpin: () => {}, setExpanded: () => {},
		});
		const render = (expanded: boolean) => act(async () => root!.render(
			<PinnedVisualContext.Provider value={state(expanded)}>
				<PinnableArtifact jobId="job_a" kind="demo"><DemoOutputCard output={DEMO} /></PinnableArtifact>
			</PinnedVisualContext.Provider>,
		));
		await render(false);
		const panel = () => host.querySelector('[data-testid="pin-panel"]')!;
		assert.equal(panel().hasAttribute("data-lh-modal"), false);
		await render(true);
		assert.equal(panel().hasAttribute("data-lh-modal"), true);
	});

	it("its own Esc shrinks it (the global Esc chain is gated by the modal)", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		const area = document.createElement("div");
		(area as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ left: 0, top: 0, width: 1400, height: 800 });
		const areaRef = { current: area };
		const view = projectView(record.slice(0, 5));
		let latest: ReturnType<typeof usePinnedVisual> | null = null;
		function Harness() {
			latest = usePinnedVisual({ messages: view, tutorPin: { callId: "p1", jobId: "job_a" }, areaRef, bottomReserve: 0, getScroller: () => null });
			return null;
		}
		await act(async () => root!.render(<Harness />));
		await act(async () => latest!.context.setExpanded(true));
		assert.equal(latest!.context.expanded, true);
		const esc = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" });
		await act(async () => { document.dispatchEvent(esc); });
		assert.equal(esc.defaultPrevented, true, "claimed");
		assert.equal(latest!.context.expanded, false, "shrunk");
	});
});

describe("an Esc inside a pinned demo", () => {
	// The demo's bridge posts {type:"demo-escape"}; the page replays it on the
	// iframe, so the page's Esc layers (Find, the tutor, the drawer, the
	// question) see it as their own, in every mode.
	(globalThis as Record<string, unknown>).KeyboardEvent ??= class extends dom.window.Event {
		key: string;
		constructor(type: string, init: { key?: string; bubbles?: boolean; cancelable?: boolean } = {}) {
			super(type, init);
			this.key = init.key ?? "";
		}
	};
	async function mount(areaWidth: number) {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		const area = document.createElement("div");
		(area as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ left: 0, top: 0, width: areaWidth, height: 800 });
		const view = projectView(record.slice(0, 5));
		const pins: { latest: ReturnType<typeof usePinnedVisual> | null } = { latest: null };
		function Harness() {
			pins.latest = usePinnedVisual({ messages: view, tutorPin: { callId: "p1", jobId: "job_a" }, areaRef: { current: area }, bottomReserve: 0, getScroller: () => null });
			return null;
		}
		await act(async () => root!.render(<Harness />));
		// The pinned card's iframe (its window is the message's source).
		const slot = document.createElement("div");
		slot.setAttribute("data-testid", "pin-slot");
		slot.setAttribute("data-pinned", "");
		const iframe = document.createElement("iframe");
		const demoWindow = {};
		Object.defineProperty(iframe, "contentWindow", { value: demoWindow });
		const panel = document.createElement("div");
		panel.setAttribute("data-testid", "pin-panel");
		panel.setAttribute("data-lh-modal", ""); // as while expanded
		panel.appendChild(iframe);
		slot.appendChild(panel);
		host.appendChild(slot);
		const fromDemo = (source: object = demoWindow) =>
			act(async () => { window.dispatchEvent(Object.assign(new dom.window.Event("message"), { data: { type: "demo-escape" }, source })); });
		return { pins, iframe, fromDemo, done: () => slot.remove() };
	}
	function heard() {
		const seen: EventTarget[] = [];
		const onKey = (e: Event) => { if ((e as KeyboardEvent).key === "Escape" && !e.defaultPrevented) seen.push(e.target!); };
		window.addEventListener("keydown", onKey);
		return { seen, stop: () => window.removeEventListener("keydown", onKey) };
	}

	it("expanded: the first shrinks it; after the shrink, the next still reaches the page", async () => {
		const { pins, iframe, fromDemo, done } = await mount(1400);
		const page = heard();
		try {
			await act(async () => pins.latest!.context.setExpanded(true));
			await fromDemo();
			assert.equal(pins.latest!.context.expanded, false, "shrunk");
			assert.equal(page.seen.length, 0, "the shrink took it");
			await fromDemo();
			assert.equal(page.seen.length, 1, "the next is the page's");
			assert.ok(page.seen[0] === iframe, "from the demo's iframe");
		} finally { page.stop(); done(); }
	});

	it("in the drawer, it reaches the page's layers (which close the drawer); another window's message does nothing", async () => {
		const { pins, fromDemo, done } = await mount(1000);
		const page = heard();
		try {
			await act(async () => pins.latest!.toggleDrawer());
			assert.deepEqual(pins.latest!.escState, { pinExpanded: false, drawer: "open" });
			await fromDemo({});
			assert.equal(page.seen.length, 0, "not from the pinned demo");
			await fromDemo();
			assert.equal(page.seen.length, 1);
		} finally { page.stop(); done(); }
	});

	it("from an unpinned demo in the transcript, too", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		const area = document.createElement("div");
		(area as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ left: 0, top: 0, width: 1400, height: 800 });
		const view = projectView(record.slice(0, 5));
		function Harness() {
			usePinnedVisual({ messages: view, tutorPin: null, areaRef: { current: area }, bottomReserve: 0, getScroller: () => null });
			return null;
		}
		await act(async () => root!.render(<Harness />));
		const iframe = document.createElement("iframe");
		const demoWindow = {};
		Object.defineProperty(iframe, "contentWindow", { value: demoWindow });
		host.appendChild(iframe);
		const page = heard();
		try {
			await act(async () => { window.dispatchEvent(Object.assign(new dom.window.Event("message"), { data: { type: "demo-escape" }, source: demoWindow })); });
			assert.equal(page.seen.length, 1);
			assert.ok(page.seen[0] === iframe, "from the demo's iframe");
		} finally { page.stop(); }
	});
});

describe("the drawer over a tall check", () => {
	it("keeps a usable height, and its tab hangs at the drawer's top, not mid-area over the check", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		const area = document.createElement("div");
		(area as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ left: 0, top: 60, width: 1000, height: 740 });
		const view = projectView(record.slice(0, 5));
		let latest: ReturnType<typeof usePinnedVisual> | null = null;
		function Harness() {
			latest = usePinnedVisual({ messages: view, tutorPin: { callId: "p1", jobId: "job_a" }, areaRef: { current: area }, bottomReserve: 700, getScroller: () => null });
			return <>{latest.drawerTab}</>;
		}
		await act(async () => root!.render(<Harness />));
		assert.equal(latest!.escState.drawer, "closed");
		assert.equal(latest!.context.frame?.maxHeight, 420, "not squeezed to a sliver above the check");
		const tab = host.querySelector('[data-testid="pin-tab"]')!;
		assert.match(tab.getAttribute("class") ?? "", /\btop-3\b/);
		assert.doesNotMatch(tab.getAttribute("class") ?? "", /top-\[40%\]/);
	});

	it("closing it with focus inside the demo hands focus to the typing field", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		const area = document.createElement("div");
		(area as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 800 });
		const view = projectView(record.slice(0, 5));
		let latest: ReturnType<typeof usePinnedVisual> | null = null;
		function Harness() {
			latest = usePinnedVisual({ messages: view, tutorPin: { callId: "p1", jobId: "job_a" }, areaRef: { current: area }, bottomReserve: 0, getScroller: () => null });
			return <div data-testid="pin-slot" data-pinned=""><iframe /></div>;
		}
		await act(async () => root!.render(<><Harness /><div data-testid="composer"><textarea data-file-path-input="" /></div></>));
		const composer = host.querySelector("textarea")!;
		let focused: Element = host.querySelector("iframe")!;
		Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused });
		const proto = dom.window.HTMLElement.prototype as unknown as { focus: (this: Element) => void };
		const realFocus = proto.focus;
		proto.focus = function () { focused = this; };
		try {
			await act(async () => latest!.toggleDrawer());
			assert.equal(latest!.escState.drawer, "open");
			await act(async () => latest!.toggleDrawer());
			assert.equal(latest!.escState.drawer, "closed");
			assert.ok(focused === composer, "the typing field");
		} finally {
			proto.focus = realFocus;
			delete (document as unknown as { activeElement?: unknown }).activeElement;
		}
	});

	it("with no typing field shown, focus leaves the hidden demo: to the folded check's bar, else off the iframe", async () => {
		for (const withBar of [true, false]) {
			const host = document.createElement("div");
			document.body.appendChild(host);
			root = createRoot(host);
			const area = document.createElement("div");
			(area as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 800 });
			const view = projectView(record.slice(0, 5));
			let latest: ReturnType<typeof usePinnedVisual> | null = null;
			function Harness() {
				latest = usePinnedVisual({ messages: view, tutorPin: { callId: "p1", jobId: "job_a" }, areaRef: { current: area }, bottomReserve: 0, getScroller: () => null });
				return <div data-testid="pin-slot" data-pinned=""><iframe /></div>;
			}
			await act(async () => root!.render(<><Harness />{withBar && <button type="button" data-testid="question-dock-bar" />}</>));
			let focused: Element = host.querySelector("iframe")!;
			Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused });
			const proto = dom.window.HTMLElement.prototype as unknown as { focus: (this: Element) => void; blur: (this: Element) => void };
			const realFocus = proto.focus;
			const realBlur = proto.blur;
			proto.focus = function () { focused = this; };
			proto.blur = function () { if (focused === this) focused = document.body; };
			try {
				await act(async () => latest!.toggleDrawer());
				await act(async () => latest!.toggleDrawer());
				assert.equal(latest!.escState.drawer, "closed");
				if (withBar) assert.ok(focused === host.querySelector('[data-testid="question-dock-bar"]'), "the folded bar");
				else assert.ok(focused === document.body, "the page");
			} finally {
				proto.focus = realFocus;
				proto.blur = realBlur;
				delete (document as unknown as { activeElement?: unknown }).activeElement;
				await act(async () => root!.unmount());
				root = null;
				host.remove();
			}
		}
	});
});
