/**
 * The lesson-tracking card (components/lesson-tracker.tsx): sections,
 * symbols and counts from the derived state, the header chip's toggle and
 * its per-device memory, and the phone-width default (hidden). linkedom.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { parseHTML } from "linkedom";
import type { LessonTracking } from "../src/core/lesson-tracking.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
let phone = false;
let storageBlocked = false;
Object.assign(dom.window, {
	localStorage: {
		getItem: (k: string) => {
			if (storageBlocked) throw new Error("blocked");
			return store.get(k) ?? null;
		},
		setItem: (k: string, v: string) => {
			if (storageBlocked) throw new Error("blocked");
			store.set(k, v);
		},
		removeItem: (k: string) => void store.delete(k),
	},
	matchMedia: (query: string) => ({ matches: phone && query.includes("max-width"), media: query }),
});
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Node: dom.window.Node,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { LessonTrackerCard, LessonTrackerChip, useLessonTrackerShown } = await import("../components/lesson-tracker.tsx");
const { deriveLessonTracking, hasLessonTracking } = await import("../src/core/lesson-tracking.ts");

let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
	if (root) await act(async () => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	store.clear();
	phone = false;
	storageBlocked = false;
});

async function mount(node: React.ReactNode) {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(node));
	return host;
}

const result = (n: number, toolName: string, details: unknown) =>
	({ id: `r${n}`, role: "toolResult", toolCallId: `c${n}`, toolName, content: [{ type: "text", text: "ok" }], details, isError: false, timestamp: n }) as unknown as LhMessage;

const record: LhMessage[] = [
	result(1, "problem_list", {
		ok: true,
		problems: [
			{ id: "q1", label: "Q1: bias of the MLE" },
			{ id: "q2", label: "Q2: CRLB bound" },
			{ id: "q3", label: "Q3: sufficiency" },
			{ id: "q4", label: "Q4: Rao-Blackwell" },
		],
	}),
	result(2, "problem_done", { ok: true, id: "q1" }),
	result(3, "problem_done", { ok: true, id: "q3" }),
	result(4, "note_mistake", { ok: true, id: "m1", text: "Variance taken as the standard deviation" }),
	result(5, "note_mistake", { ok: true, id: "m2", text: "Drops the n in the Fisher information" }),
	result(6, "note_mistake", { ok: true, id: "m3", text: "Forgets the regularity conditions" }),
	result(7, "resolve_mistake", { ok: true, id: "m1" }),
];

const rows = (host: Element, section: string) =>
	[...host.querySelectorAll(`[data-testid="lesson-tracker-${section}"] li`)].map((li) => [li.getAttribute("data-status"), li.textContent]);
const count = (host: Element, section: string) =>
	host.querySelector(`[data-testid="lesson-tracker-${section}"] [data-testid="lesson-tracker-count"]`)?.textContent;

it("renders both sections with symbols and counts", async () => {
	const host = await mount(<LessonTrackerCard tracking={deriveLessonTracking(record)} bottomReserve={200} />);
	const card = host.querySelector('[data-testid="lesson-tracker"]')!;
	assert.ok(card, "the card renders");
	assert.match(card.querySelector("h3")!.textContent!, /^Problems/);
	assert.equal(count(host, "problems"), "2/4");
	assert.deepEqual(rows(host, "problems"), [
		["done", "✓Q1: bias of the MLE"],
		["current", "▸Q2: CRLB bound"],
		["done", "✓Q3: sufficiency"],
		["todo", "○Q4: Rao-Blackwell"],
	]);
	assert.equal(count(host, "mistakes"), "2 open");
	assert.deepEqual(rows(host, "mistakes"), [
		["resolved", "✓Variance taken as the standard deviation"],
		["open", "○Drops the n in the Fisher information"],
		["open", "○Forgets the regularity conditions"],
	]);
	// Never reaches the composer: the dock's reserve bounds its height.
	assert.match(card.getAttribute("style") ?? "", /max-height:\s*calc\(100% - 224px\)/);
});

it("shows only the sections that exist", async () => {
	const mistakesOnly: LessonTracking = deriveLessonTracking([record[3]!]);
	let host = await mount(<LessonTrackerCard tracking={mistakesOnly} bottomReserve={0} />);
	assert.equal(host.querySelector('[data-testid="lesson-tracker-problems"]'), null);
	assert.equal(count(host, "mistakes"), "1 open");
	await act(async () => root!.unmount());
	const listOnly = deriveLessonTracking([record[0]!]);
	host = await mount(<LessonTrackerCard tracking={listOnly} bottomReserve={0} />);
	assert.equal(host.querySelector('[data-testid="lesson-tracker-mistakes"]'), null);
	assert.equal(count(host, "problems"), "0/4");
	assert.equal(rows(host, "problems")[0]![0], "current", "the first not-done problem is current");
	// All done: no current row.
	const allDone = deriveLessonTracking([record[0]!, ...["q1", "q2", "q3", "q4"].map((id, i) => result(10 + i, "problem_done", { ok: true, id }))]);
	await act(async () => root!.render(<LessonTrackerCard tracking={allDone} bottomReserve={0} />));
	assert.equal(count(host, "problems"), "4/4");
	assert.deepEqual(rows(host, "problems").map((r) => r[0]), ["done", "done", "done", "done"]);
});

/** The chat's wiring (components/chat.tsx): chip in the header when the
 *  lesson has anything to track, card while shown. */
function Harness({ messages }: { messages: LhMessage[] }) {
	const tracking = deriveLessonTracking(messages);
	const { shown, toggle } = useLessonTrackerShown();
	if (!hasLessonTracking(tracking)) return <div data-testid="empty" />;
	return (
		<>
			<LessonTrackerChip shown={shown} onToggle={toggle} />
			{shown && <LessonTrackerCard tracking={tracking} bottomReserve={0} />}
		</>
	);
}

const chip = (host: Element) => host.querySelector('[data-testid="lesson-tracker-chip"]') as HTMLButtonElement;
const card = (host: Element) => host.querySelector('[data-testid="lesson-tracker"]');

it("shown by default; the chip toggles it and the choice is remembered", async () => {
	let host = await mount(<Harness messages={record} />);
	assert.ok(card(host), "shown by default on a wide layout");
	assert.equal(chip(host).getAttribute("aria-pressed"), "true");
	await act(async () => chip(host).click());
	assert.equal(card(host), null);
	assert.equal(chip(host).getAttribute("aria-pressed"), "false");
	assert.equal(store.get("lh:lesson-tracker"), "0");

	// A remount (reload) keeps the choice.
	await act(async () => root!.unmount());
	host = await mount(<Harness messages={record} />);
	assert.equal(card(host), null, "hidden stays hidden after a reload");
	await act(async () => chip(host).click());
	assert.ok(card(host));
	assert.equal(store.get("lh:lesson-tracker"), "1");
});

it("updates live as tracking results arrive; no chip or card before any", async () => {
	const host = await mount(<Harness messages={[]} />);
	assert.ok(host.querySelector('[data-testid="empty"]'));
	assert.equal(chip(host), null);
	await act(async () => root!.render(<Harness messages={record.slice(0, 1)} />));
	assert.equal(count(host, "problems"), "0/4");
	await act(async () => root!.render(<Harness messages={record.slice(0, 2)} />));
	assert.equal(count(host, "problems"), "1/4");
	await act(async () => root!.render(<Harness messages={record} />));
	assert.equal(count(host, "mistakes"), "2 open");
});

it("phone width starts hidden and opens from the chip", async () => {
	phone = true;
	store.set("lh:lesson-tracker", "1");
	const host = await mount(<Harness messages={record} />);
	assert.equal(card(host), null, "a phone-width layout starts hidden");
	assert.ok(chip(host));
	await act(async () => chip(host).click());
	assert.ok(card(host), "the chip opens it");
});

it("blocked storage costs only the memory", async () => {
	storageBlocked = true;
	const host = await mount(<Harness messages={record} />);
	assert.ok(card(host));
	await act(async () => chip(host).click());
	assert.equal(card(host), null);
});
