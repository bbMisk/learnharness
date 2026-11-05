/**
 * The lesson-tracking card (components/lesson-tracker.tsx): sections,
 * symbols and counts from the derived state, the header chip's toggle and
 * its per-device memory, and the phone-width default (hidden). linkedom.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import fs from "node:fs";
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
const { LessonTrackerCard, LessonTrackerChip, lessonTrackerRoom, useLessonTrackerShown } = await import("../components/lesson-tracker.tsx");
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
			{ id: "q5", label: "Q5: UMVUE" },
		],
	}),
	// The owner's iPad case: the teacher works out of order — Q3 first.
	result(2, "problem_start", { ok: true, id: "q3" }),
	result(3, "problem_done", { ok: true, id: "q3", outcome: "correct" }),
	result(4, "note_mistake", { ok: true, id: "m1", text: "Variance taken as the standard deviation" }),
	result(5, "note_mistake", { ok: true, id: "m2", text: "Drops the n in the Fisher information" }),
	result(6, "note_mistake", { ok: true, id: "m3", text: "Forgets the regularity conditions" }),
	result(7, "resolve_mistake", { ok: true, id: "m1" }),
	result(8, "problem_start", { ok: true, id: "q1" }),
	result(9, "problem_done", { ok: true, id: "q1", outcome: "incorrect" }),
	result(10, "problem_done", { ok: true, id: "q4", outcome: "skipped" }),
	result(11, "problem_start", { ok: true, id: "q2" }),
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
	assert.equal(count(host, "problems"), "1/5", "correct / total");
	assert.deepEqual(rows(host, "problems"), [
		["incorrect", "✗Q1: bias of the MLE"],
		["current", "▸Q2: CRLB bound"],
		["correct", "✓Q3: sufficiency"],
		["skipped", "–Q4: Rao-Blackwell"],
		["todo", "○Q5: UMVUE"],
	]);
	// Colours: the quiz feedback's green/red (answered-card.tsx), grey for skipped; bold for current.
	const problemRow = (status: string) => host.querySelector(`[data-testid="lesson-tracker-problems"] li[data-status="${status}"]`)!;
	const symbolClass = (status: string) => problemRow(status).querySelector('[data-testid="lesson-tracker-symbol"]')!.getAttribute("class")!;
	assert.match(symbolClass("correct"), /\btext-green-500\b/);
	assert.match(symbolClass("incorrect"), /\btext-red-500\b/);
	assert.match(symbolClass("skipped"), /\btext-muted-foreground\b/);
	assert.doesNotMatch(symbolClass("todo"), /text-(green|red)-500/);
	assert.match(problemRow("current").getAttribute("class")!, /\bfont-semibold\b/);
	for (const status of ["correct", "incorrect", "skipped", "todo"]) {
		assert.doesNotMatch(problemRow(status).getAttribute("class")!, /font-semibold/, `${status} is not bold`);
	}
	assert.equal(count(host, "mistakes"), "2 open · 1 fixed");
	// Open first; a resolved mistake is archived below them (owner, 2026-11-05).
	assert.deepEqual(rows(host, "mistakes"), [
		["open", "○Drops the n in the Fisher information"],
		["open", "○Forgets the regularity conditions"],
		["resolved", "✓Variance taken as the standard deviation"],
	]);
	const resolved = host.querySelector('[data-testid="lesson-tracker-mistakes"] li[data-status="resolved"]')!;
	const resolvedText = resolved.querySelectorAll("span")[1]!.getAttribute("class")!;
	assert.match(resolvedText, /\bline-through\b/, "crossed out");
	assert.match(resolvedText, /\btruncate\b/, "one line");
	assert.match(resolved.getAttribute("class")!, /text-\[10\.5px\]/, "smaller");
	assert.match(resolved.getAttribute("class")!, /text-muted-foreground\/60/, "dimmed");
	assert.equal(resolved.getAttribute("title"), "Variance taken as the standard deviation", "full text on hover");
	for (const open of host.querySelectorAll('[data-testid="lesson-tracker-mistakes"] li[data-status="open"]')) {
		assert.doesNotMatch(open.getAttribute("class")!, /line-through|truncate/);
	}
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
	assert.equal(count(host, "problems"), "0/5");
	assert.deepEqual(rows(host, "problems").map((r) => r[0]), ["todo", "todo", "todo", "todo", "todo"], "nothing started: nothing current");
	// Legacy records (no outcome) read as correct; a restarted correct problem is current and still counted (hunt finding).
	const legacy = deriveLessonTracking([record[0]!, ...["q1", "q2", "q3", "q4", "q5"].map((id, i) => result(20 + i, "problem_done", { ok: true, id }))]);
	await act(async () => root!.render(<LessonTrackerCard tracking={legacy} bottomReserve={0} />));
	assert.equal(count(host, "problems"), "5/5");
	assert.deepEqual(rows(host, "problems").map((r) => r[0]), ["correct", "correct", "correct", "correct", "correct"]);
	const redo = deriveLessonTracking([record[0]!, result(30, "problem_done", { ok: true, id: "q2", outcome: "correct" }), result(31, "problem_start", { ok: true, id: "q2" })]);
	await act(async () => root!.render(<LessonTrackerCard tracking={redo} bottomReserve={0} />));
	assert.equal(count(host, "problems"), "1/5");
	assert.equal(rows(host, "problems")[1]![0], "current");
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
	assert.equal(count(host, "problems"), "0/5");
	await act(async () => root!.render(<Harness messages={record.slice(0, 2)} />));
	assert.equal(rows(host, "problems")[2]![0], "current");
	await act(async () => root!.render(<Harness messages={record.slice(0, 3)} />));
	assert.equal(count(host, "problems"), "1/5");
	await act(async () => root!.render(<Harness messages={record} />));
	assert.equal(count(host, "mistakes"), "2 open · 1 fixed");
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

it("makes room: while shown on a wide session area the column clears the card; otherwise layout is untouched", async () => {
	assert.deepEqual(lessonTrackerRoom(false), { area: "", column: "" }, "hidden or absent: no layout change");
	const room = lessonTrackerRoom(true);
	// The classes compile to a container query on the session area: at
	// 64rem and up the column's right padding is the card's lane (16rem
	// card + 0.75rem gap) plus the column's own 1.5rem gutter.
	const { compile } = await import("tailwindcss");
	const css = (await compile("@tailwind utilities;", { base: process.cwd() })).build([room.area, room.column]);
	assert.match(css, /container-type: inline-size;\s*container-name: session;/);
	assert.match(css, /@container session \(width >= 64rem\) \{[^}]*\{\s*padding-right: 18\.25rem;/);
	// The card's geometry matches the lane the padding reserves.
	const host = await mount(<LessonTrackerCard tracking={deriveLessonTracking(record)} bottomReserve={0} />);
	const cls = host.querySelector('[data-testid="lesson-tracker"]')!.getAttribute("class")!.split(" ");
	assert.ok(cls.includes("w-64") && cls.includes("right-3"));
	// The chat applies them: the session area and the transcript column.
	const chat = fs.readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
	assert.match(chat, /lessonTrackerRoom\(hasTracking && trackerCard\.shown\)/);
	assert.match(chat, /className=\{`relative flex min-h-0 flex-1 \$\{trackerRoom\.area\}`\}/);
	assert.match(chat, /data-session-find-root="" className=\{`\$\{COLUMN\}[^`]*\$\{trackerRoom\.column\}`\}/);
});
