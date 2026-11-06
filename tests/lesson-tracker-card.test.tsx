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

/** What a sighted reader sees (screen-reader-only text removed) and what a
 *  screen reader reads (aria-hidden parts removed). */
const textWithout = (el: Element, selector: string) => {
	const copy = el.cloneNode(true) as Element;
	for (const hidden of copy.querySelectorAll(selector)) hidden.remove();
	return copy.textContent;
};
const visible = (el: Element) => textWithout(el, ".sr-only");
const spoken = (el: Element) => textWithout(el, "[aria-hidden]");
const rows = (host: Element, section: string) =>
	[...host.querySelectorAll(`[data-testid="lesson-tracker-${section}"] li`)].map((li) => [li.getAttribute("data-status"), visible(li)]);
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
	const unfold = resolved.querySelector("button")!;
	assert.equal(unfold.getAttribute("title"), "Variance taken as the standard deviation", "full text on hover");
	// Touch and keyboard: the row is a button that unfolds the full text.
	assert.equal(unfold.getAttribute("aria-expanded"), "false");
	await act(async () => unfold.click());
	assert.equal(unfold.getAttribute("aria-expanded"), "true");
	assert.doesNotMatch(resolved.querySelectorAll("span")[1]!.getAttribute("class")!, /\btruncate\b/, "unfolded");
	assert.match(resolved.querySelectorAll("span")[1]!.getAttribute("class")!, /\bline-through\b/, "still crossed out");
	await act(async () => unfold.click());
	assert.match(resolved.querySelectorAll("span")[1]!.getAttribute("class")!, /\btruncate\b/, "folds again");
	for (const open of host.querySelectorAll('[data-testid="lesson-tracker-mistakes"] li[data-status="open"]')) {
		assert.doesNotMatch(open.getAttribute("class")!, /line-through|truncate/);
	}
	// Never reaches the composer: the dock's reserve bounds its height.
	// Narrow: stops above the dock (its height + a margin); wide (room made): the pane's full height.
	assert.match(card.getAttribute("style") ?? "", /--lh-card-reserve:\s*224px/);
	assert.match(card.getAttribute("class")!, /max-h-\[calc\(100%-var\(--lh-card-reserve\)\)\]/);
	assert.match(card.getAttribute("class")!, /@min-\[64rem\]\/session:max-h-\[calc\(100%-1\.5rem\)\]/, "the room breakpoint the dock uses");
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
	// Legacy records (no outcome) read as correct; a restarted correct problem is current and still counted.
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
	assert.deepEqual(lessonTrackerRoom(false), { area: "", column: "", dock: "" }, "hidden or absent: no layout change");
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

// ─── the Plan section (owner, 2026-11-05 — src/core/plan-progress.ts) ─────────

const { lessonPlanProgress } = await import("../src/core/plan-progress.ts");
type PlanTree = import("../src/core/contracts.ts").PlanTree;
type ViewMessage = import("../src/core/plan-progress.ts").PlanProgressMessage;

const planTree: PlanTree = {
	nodes: [
		{ id: "score", title: "The score function" },
		{ id: "fisher", title: "Fisher information" },
		{ id: "crlb", title: "The Cramér-Rao bound" },
		{ id: "efficiency", title: "Efficiency" },
	],
	edges: [
		{ from: "score", to: "fisher" },
		{ from: "fisher", to: "crlb" },
		{ from: "crlb", to: "efficiency" },
	],
	version: 1,
};
const graded = (correct: boolean) => ({ kind: "quiz", dontKnow: false, correct, answers: [], questionText: "q", answeredAt: "t" });
const tagged = (nodeId: string, answer?: unknown) =>
	answer === undefined
		? { type: "tool-quiz", state: "input-available", input: { nodeId } }
		: { type: "tool-quiz", state: "output-available", input: { nodeId }, output: answer };
/** The transcript view: score 1/2 (latest right), fisher 1/2 (latest wrong), crlb current and unanswered. */
const planView: ViewMessage[] = [
	{ parts: [tagged("score", graded(false)), tagged("score", graded(true))] },
	{ parts: [tagged("fisher", graded(true)), tagged("fisher", graded(false))] },
	{ parts: [tagged("crlb")] },
];

/** The chat's wiring with the plan (components/chat.tsx): the section only
 *  in a non-cram teach lesson with a plan; the chip while any section exists. */
function PlanHarness({ messages = [], tree = planTree, view = planView, cram = false }: { messages?: LhMessage[]; tree?: PlanTree | null; view?: ViewMessage[]; cram?: boolean }) {
	const tracking = deriveLessonTracking(messages);
	const plan = lessonPlanProgress(tree, view, { cram, practice: false });
	const { shown, toggle } = useLessonTrackerShown();
	if (!hasLessonTracking(tracking) && plan === null) return <div data-testid="empty" />;
	return (
		<>
			<LessonTrackerChip shown={shown} onToggle={toggle} />
			{shown && <LessonTrackerCard tracking={tracking} plan={plan} bottomReserve={160} />}
		</>
	);
}

const planRow = (host: Element, status: string) => host.querySelector(`[data-testid="lesson-tracker-plan"] li[data-status="${status}"]`)!;
const score = (li: Element) => li.querySelector('[data-testid="lesson-tracker-score"]');

it("plan: a teach lesson with a plan shows the section — covered/total, one row per step, scores", async () => {
	const host = await mount(<PlanHarness />);
	assert.ok(chip(host), "a plan-only lesson gets the chip");
	assert.ok(card(host), "and the card, shown by default");
	assert.equal(count(host, "plan"), "2/4", "covered excludes the current step");
	assert.deepEqual(rows(host, "plan"), [
		["covered", "✓The score function1/2"],
		["covered", "✓Fisher information1/2"],
		["current", "▸The Cramér-Rao bound"],
		["upcoming", "○Efficiency"],
	]);
	// Symbols as the problem rows: bold current; ✓ and ○ muted (moved past is not "correct").
	assert.match(planRow(host, "current").getAttribute("class")!, /\bfont-semibold\b/);
	for (const status of ["covered", "upcoming"]) {
		const li = host.querySelectorAll(`[data-testid="lesson-tracker-plan"] li[data-status="${status}"]`);
		for (const row of li) {
			assert.match(row.getAttribute("class")!, /\btext-muted-foreground\b/);
			assert.doesNotMatch(row.getAttribute("class")!, /font-semibold/);
			assert.doesNotMatch(row.querySelector('[data-testid="lesson-tracker-symbol"]')!.getAttribute("class")!, /text-(green|red)-500/);
		}
	}
	// Scores: right-aligned, tabular; green when the latest answer was right, red when wrong; none unanswered.
	const [scoreRow, fisherRow] = host.querySelectorAll('[data-testid="lesson-tracker-plan"] li[data-status="covered"]');
	assert.equal(visible(score(scoreRow!)!), "1/2");
	assert.match(score(scoreRow!)!.getAttribute("class")!, /\btext-green-500\b/);
	assert.match(score(scoreRow!)!.getAttribute("class")!, /\bml-auto\b.*\btabular-nums\b/);
	assert.equal(visible(score(fisherRow!)!), "1/2");
	assert.match(score(fisherRow!)!.getAttribute("class")!, /\btext-red-500\b/);
	assert.equal(score(planRow(host, "current")), null, "no answered check: no score");
	assert.equal(score(planRow(host, "upcoming")), null);
	// An ungraded (explain) answer: no score at all, not a grey "0/1".
	const explainView: ViewMessage[] = [{ parts: [{ type: "tool-explain", state: "output-available", input: { nodeId: "score" }, output: { kind: "explain", dontKnow: false, answers: [], text: "x", questionText: "q", answeredAt: "t" } }] }];
	await act(async () => root!.render(<PlanHarness view={explainView} />));
	assert.equal(score(planRow(host, "current")), null);
});

it("plan: updates live as tagged checks stream in and answers land", async () => {
	const host = await mount(<PlanHarness view={[]} />);
	assert.equal(count(host, "plan"), "0/4");
	assert.deepEqual(rows(host, "plan").map((r) => r[0]), ["upcoming", "upcoming", "upcoming", "upcoming"]);
	await act(async () => root!.render(<PlanHarness view={[{ parts: [tagged("score")] }]} />));
	assert.equal(rows(host, "plan")[0]![0], "current");
	assert.equal(score(planRow(host, "current")), null, "posed, not answered");
	await act(async () => root!.render(<PlanHarness view={[{ parts: [tagged("score", graded(true))] }]} />));
	assert.equal(visible(score(planRow(host, "current"))!), "1/1");
	await act(async () => root!.render(<PlanHarness view={[{ parts: [tagged("score", graded(true))] }, { parts: [tagged("fisher")] }]} />));
	assert.equal(count(host, "plan"), "1/4");
	assert.deepEqual(rows(host, "plan").map((r) => r[0]), ["covered", "current", "upcoming", "upcoming"]);
});

it("plan: none in cram (Problems + Mistakes only), none without a plan", async () => {
	// Cram with a problem list: the card keeps Problems + Mistakes, no Plan.
	let host = await mount(<PlanHarness cram messages={record} />);
	assert.ok(card(host));
	assert.equal(host.querySelector('[data-testid="lesson-tracker-plan"]'), null, "no plan section in cram");
	assert.ok(host.querySelector('[data-testid="lesson-tracker-problems"]'));
	assert.ok(host.querySelector('[data-testid="lesson-tracker-mistakes"]'));
	// Cram with a plan and nothing else tracked: no chip, no card.
	await act(async () => root!.render(<PlanHarness cram />));
	assert.ok(host.querySelector('[data-testid="empty"]'));
	assert.equal(chip(host), null);
	await act(async () => root!.unmount());
	// No plan (none, or an empty tree): no section; nothing else → no chip.
	host = await mount(<PlanHarness tree={null} />);
	assert.equal(chip(host), null);
	await act(async () => root!.render(<PlanHarness tree={{ nodes: [], edges: [], version: 1 }} />));
	assert.equal(chip(host), null);
	await act(async () => root!.render(<PlanHarness tree={null} messages={[record[3]!]} />));
	assert.ok(card(host));
	assert.equal(host.querySelector('[data-testid="lesson-tracker-plan"]'), null);
});

it("plan: Plan first, then Mistakes; a long plan scrolls inside the card, bounded by the dock", async () => {
	const host = await mount(<PlanHarness messages={record.slice(3, 7)} />);
	const sections = [...card(host)!.querySelectorAll("section")].map((s) => s.getAttribute("data-testid"));
	assert.deepEqual(sections, ["lesson-tracker-plan", "lesson-tracker-mistakes"]);
	const long: PlanTree = { nodes: Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, title: `Step ${i}` })), edges: [], version: 1 };
	await act(async () => root!.render(<PlanHarness tree={long} view={[]} />));
	assert.equal(rows(host, "plan").length, 40);
	assert.match(card(host)!.getAttribute("class")!, /\boverflow-y-auto\b/);
	assert.match(card(host)!.getAttribute("style") ?? "", /--lh-card-reserve:\s*184px/);
});

it("plan: the chat wires the section with the cram/practice gate and counts it for the chip", () => {
	const chat = fs.readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
	assert.match(chat, /lessonPlanProgress\(planTree, messages, \{ cram, practice: kind === "practice" \}\)/);
	assert.match(chat, /const hasTracking = hasLessonTracking\(tracking\) \|\| planProgress !== null;/);
	assert.match(chat, /\{hasTracking && <LessonTrackerChip /);
	assert.match(chat, /<LessonTrackerCard tracking=\{tracking\} plan=\{planProgress\} /);
});

it("makes room for the dock too: it centres on the narrowed column while the card shows on a wide area, untouched otherwise", async () => {
	// Hidden or absent card (and, through the container query, narrow areas): no dock classes at all.
	assert.equal(lessonTrackerRoom(false).dock, "", "card hidden or absent: the dock's layout is unchanged");
	const room = lessonTrackerRoom(true);
	const { compile } = await import("tailwindcss");
	const build = async (classes: string[]) => (await compile("@tailwind utilities;", { base: process.cwd() })).build(classes);
	const QUERY = /@container session \(width >= 64rem\) \{([\s\S]*?)\n\}/;
	const inQuery = (css: string, prop: string) => css.match(QUERY)?.[1]?.match(new RegExp(`\\b${prop}: ([^;]+);`))?.[1];
	const dockCss = await build(room.dock.split(" "));
	const columnCss = await build([room.column]);
	// The same breakpoint as the column, and the column's own padding box:
	// its room-making right and its px-6 (1.5rem) left — so the dock centres
	// in exactly the column's content box (owner, 2026-11-05).
	assert.equal(inQuery(dockCss, "padding-right"), "18.25rem");
	assert.equal(inQuery(dockCss, "padding-right"), inQuery(columnCss, "padding-right"), "the same right offset as the column");
	assert.equal(inQuery(dockCss, "padding-left"), "1.5rem", "the column's px-6 left gutter");
	assert.doesNotMatch(dockCss.replace(QUERY, ""), /padding/, "nothing outside the wide-area query");
	// The chat applies them: the column carries px-6, and the dock block (the
	// one wrapper of the question card, composer, reading field, queued steers,
	// setup/plan-accept bar and footer row) takes the dock classes.
	const chat = fs.readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
	assert.match(chat, /const COLUMN = "mx-auto w-full max-w-none px-6";/);
	assert.match(chat, /room=\{trackerRoom\.dock\}/);
	assert.match(chat, /<div ref=\{blockRef\} data-testid="dock-block" className=\{`relative bg-background pb-5 \$\{room\}`\}>\s*<div className=\{DOCK\}>/);
});

it("plan: screen readers get each step's status and its score in words; the visual design is unchanged", async () => {
	const host = await mount(<PlanHarness />);
	const items = [...host.querySelectorAll('[data-testid="lesson-tracker-plan"] li')];
	assert.deepEqual(items.map(spoken), [
		"Covered: The score function, 1 of 2 checks right, latest right",
		"Covered: Fisher information, 1 of 2 checks right, latest wrong",
		"Current step: The Cramér-Rao bound",
		"Not started: Efficiency",
	]);
	// The words are visually hidden (sr-only); what shows is exactly as before.
	assert.deepEqual(items.map(visible), ["✓The score function1/2", "✓Fisher information1/2", "▸The Cramér-Rao bound", "○Efficiency"]);
	for (const li of items) assert.equal(li.querySelector('[data-testid="lesson-tracker-symbol"]')!.getAttribute("aria-hidden"), "true");
	const scoreEl = score(items[0]!)!;
	assert.equal(scoreEl.querySelector(".sr-only")!.textContent, ", 1 of 2 checks right, latest right");
	assert.equal(scoreEl.querySelector("[aria-hidden]")!.textContent, "1/2");
	// One check reads in the singular.
	await act(async () => root!.render(<PlanHarness view={[{ parts: [tagged("score", graded(false))] }]} />));
	assert.equal(spoken(planRow(host, "current")), "Current step: The score function, 0 of 1 check right, latest wrong");
});

// ─── Practice weak spots (owner, 2026-11-06) ─────────────────────────────────

const { lessonWeakSpots, weakSpotsPracticePrompt } = await import("../src/core/lesson-tracking.ts");
const { startWeakSpotsPractice } = await import("../components/start-session.ts");
const practiceButton = (host: Element) => host.querySelector('[data-testid="lesson-tracker-practice"]') as HTMLButtonElement | null;

it("weak spots: a button while a plan step's latest check is wrong or a mistake is open; clicking passes them", async () => {
	const tracking = deriveLessonTracking(record);
	const plan = lessonPlanProgress(planTree, planView, { cram: false, practice: false });
	const started: string[][] = [];
	const onPracticeWeakSpots = async (spots: string[]) => void started.push(spots);
	const host = await mount(<LessonTrackerCard tracking={tracking} plan={plan} bottomReserve={0} onPracticeWeakSpots={onPracticeWeakSpots} />);
	assert.equal(practiceButton(host)!.textContent, "Practice weak spots");
	await act(async () => practiceButton(host)!.click());
	// Red steps first (fisher: latest wrong; score's latest is right), then the open mistakes (m1 is fixed).
	assert.deepEqual(started, [["Fisher information", "Drops the n in the Fisher information", "Forgets the regularity conditions"]]);
	// Only resolved mistakes and no red step: no weak spots, no button.
	const fixedOnly = deriveLessonTracking([record[3]!, record[6]!]);
	const greenPlan = lessonPlanProgress(planTree, [{ parts: [tagged("score", graded(true))] }], { cram: false, practice: false });
	assert.deepEqual(lessonWeakSpots(fixedOnly, greenPlan), []);
	await act(async () => root!.render(<LessonTrackerCard tracking={fixedOnly} plan={greenPlan} bottomReserve={0} onPracticeWeakSpots={onPracticeWeakSpots} />));
	assert.ok(card(host) && !practiceButton(host));
	// No handler (models not set up): no button even with weak spots.
	await act(async () => root!.render(<LessonTrackerCard tracking={tracking} plan={plan} bottomReserve={0} />));
	assert.equal(practiceButton(host), null);
	// Practice sessions carry no plan section and no mistake tools: nothing to practise.
	assert.equal(lessonPlanProgress(planTree, planView, { cram: false, practice: true }), null);
	assert.deepEqual(lessonWeakSpots(deriveLessonTracking([]), null), []);
});

it("weak spots: a failed start re-enables the button with a retry message", async () => {
	const host = await mount(
		<LessonTrackerCard tracking={deriveLessonTracking(record)} bottomReserve={0} onPracticeWeakSpots={async () => { throw new Error("x"); }} />,
	);
	await act(async () => practiceButton(host)!.click());
	assert.match(host.querySelector('[role="alert"]')!.textContent!, /Couldn’t start the practice session/);
	assert.equal(practiceButton(host)!.disabled, false);
});

it("weak spots: the click creates a practice chat in the lesson's project, opened by the seed message", async () => {
	const session = new Map<string, string>();
	const prev = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
	Object.defineProperty(globalThis, "sessionStorage", {
		configurable: true,
		value: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k) },
	});
	try {
		const posts: unknown[] = [];
		const fetchLike = (async (url: string, init: RequestInit) => {
			assert.equal(url, "/api/chats");
			posts.push(JSON.parse(init.body as string));
			return Response.json({ id: "c_ws" });
		}) as unknown as typeof fetch;
		const seed = weakSpotsPracticePrompt("Fisher information", ["Fisher information", "Drops the n"]);
		assert.equal(seed, "Practice my weak spots from the lesson “Fisher information”:\n- Fisher information\n- Drops the n");
		assert.equal(await startWeakSpotsPractice("Fisher information", ["Fisher information", "Drops the n"], "project_stats", fetchLike), "/chat/c_ws");
		assert.deepEqual(posts, [{ title: seed, kind: "practice", projectId: "project_stats" }]);
		assert.equal(JSON.parse(session.get("lh.openingPrompt.c_ws")!).text, seed, "the seed is the new session's opening message");
		await startWeakSpotsPractice("L", ["x"], undefined, fetchLike);
		assert.deepEqual(posts[1], { title: weakSpotsPracticePrompt("L", ["x"]), kind: "practice" }, "no project: none sent");
	} finally {
		if (prev) Object.defineProperty(globalThis, "sessionStorage", prev);
		else Reflect.deleteProperty(globalThis, "sessionStorage");
	}
	// The chat wires it: the page's project, gated on working models.
	const chat = fs.readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
	assert.match(chat, /onPracticeWeakSpots=\{configured && !zeroKeys \? practiceWeakSpots : undefined\}/);
	assert.match(chat, /startWeakSpotsPractice\(titleText, spots, projectId, fetch, weakSpotsStarterRef\.current\)/);
	const page = fs.readFileSync(new URL("../app/chat/[id]/page.tsx", import.meta.url), "utf8");
	assert.match(page, /projectId=\{chat\.projectId\}/);
});
