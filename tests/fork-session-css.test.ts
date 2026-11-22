/**
 * The fork's session-page CSS (app/globals.css, fork review 2026-11-22):
 * - room for the Progress card with a transcript width set: the column keeps
 *   the full set width unless the centred column would reach the card, and
 *   the dock block mirrors the column so a widened question card lines up
 *   with the text's edges (the card's lane is reported to the flank);
 * - the side tutor wraps inline code and math again.
 * The rules are evaluated numerically for a range of session-area widths.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { it } from "node:test";
import { lessonTrackerRoom } from "../components/lesson-tracker.tsx";
import { dockContainerMax } from "../components/question-layout.ts";
import { GLOBALS_CSS, declarationsFor, evalPx, sessionQueryHolding } from "./helpers/room-css.ts";

const REM = 16;
const CARD_LANE = 16.75 * REM; // w-64 + right-3
const GUTTER = 1.5 * REM; // the column's px-6

/** Upstream's column box: centred, max-width = set width + 1rem (Full: the area). */
const columnBox = (area: number, setRem: number | null) => {
	const width = setRem === null ? area : Math.min(area, (setRem + 1) * REM);
	return { left: (area - width) / 2, right: (area + width) / 2 };
};

function geometry(area: number, setRem: number | null) {
	const block = sessionQueryHolding(".lh-room-column");
	const inherited: Record<string, string> = setRem === null ? {} : { "--lh-transcript-max": `${setRem}rem` };
	const column = declarationsFor(block, ".lh-room-column");
	const dock = declarationsFor(block, ".lh-room-dock");
	const px = (decls: Map<string, string>, prop: string) => evalPx(decls.get(prop)!, decls, inherited, area, REM);
	const box = columnBox(area, setRem);
	const text = { left: box.left + GUTTER, right: box.right - px(column, "padding-right") };
	const dockBox = { left: px(dock, "padding-left"), right: area - px(dock, "padding-right") };
	// The widest question card: the container DockOverlay allows, centred in
	// the block's content box, minus the dock's px-4 on each side.
	const container = dockContainerMax(dockBox.right - dockBox.left, REM, setRem);
	const centre = (dockBox.left + dockBox.right) / 2;
	const card = { left: centre - container / 2 + REM, right: centre + container / 2 - REM };
	return { text, dockBox, card, lane: px(dock, "--lh-room-lane") };
}

const AREAS = [960, 1100, 1280, 1440, 1600, 1920, 2560];

it("the room classes are the fork's CSS classes, inside the session-area query", () => {
	assert.deepEqual(lessonTrackerRoom(true), { area: "@container/session", column: "lh-room-column", dock: "lh-room-dock" });
	const block = sessionQueryHolding(".lh-room-column");
	assert.ok(block.includes(".lh-room-dock"), "both in the same 60rem query");
	assert.match(GLOBALS_CSS, /@property --lh-room-lane \{\s*syntax: "<length>";/, "registered, so the computed lane reads in px");
	// Outside the query nothing pads: the classes appear only inside it.
	const outside = GLOBALS_CSS.replace(/@container session \(min-width: 60rem\) \{[\s\S]*?\n\}/g, "");
	assert.doesNotMatch(outside, /\.lh-room-(column|dock)\s*[,{]/);
});

it("Full (no transcript width): the old geometry, and the card lines up with the text", () => {
	for (const area of AREAS) {
		const g = geometry(area, null);
		assert.equal(area - g.text.right, 18.25 * REM, `${area}: the column clears the card's lane + its gutter`);
		assert.equal(g.lane, CARD_LANE);
		assert.equal(g.dockBox.left, 0);
		assert.equal(area - g.dockBox.right, CARD_LANE, "the dock shifts by the card's lane");
		assert.ok(Math.abs(g.card.left - g.text.left) < 0.5 && Math.abs(g.card.right - g.text.right) < 0.5, `${area}: the widened card meets the text's edges`);
	}
});

it("a set width clear of the card keeps the full width; one that would reach it gives up only the overlap", () => {
	for (const setRem of [36, 46, 56, 70]) {
		for (const area of AREAS) {
			const g = geometry(area, setRem);
			const width = g.text.right - g.text.left;
			const box = columnBox(area, setRem);
			const clear = box.right - GUTTER <= area - 18.25 * REM;
			if (clear) assert.equal(width, (setRem - 2) * REM, `${setRem}rem @ ${area}: the full set width`);
			else assert.ok(Math.abs(g.text.right - (area - 18.25 * REM)) < 0.01, `${setRem}rem @ ${area}: stops just short of the card`);
			assert.ok(g.text.right <= area - 18.25 * REM + 0.01, "never under the card");
			assert.equal(g.lane, CARD_LANE, "the marginalia still stops left of the card");
			assert.ok(Math.abs(g.card.left - g.text.left) < 0.5 && Math.abs(g.card.right - g.text.right) < 0.5,
				`${setRem}rem @ ${area}: the widened card meets the text's edges`);
		}
	}
});

it("the side tutor wraps inline code and math, overriding upstream's session no-wrap rules", () => {
	const tutor = fs.readFileSync(new URL("../components/side-tutor.tsx", import.meta.url), "utf8");
	assert.match(tutor, /data-testid="side-tutor"[\s\S]{0,120}data-side-tutor=""/);
	// Upstream's rules stay as they were.
	assert.match(GLOBALS_CSS, /\[data-session-surface\] \[data-streamdown="inline-code"\],\n\[data-session-surface\] :not\(\.katex-display\) > \.katex \{[^}]*white-space: nowrap;/);
	const override = GLOBALS_CSS.match(/((?:\[data-session-surface\] \[data-side-tutor\][^,{]*,?\s*)+)\{([^}]*)\}/);
	assert.ok(override, "an override scoped to the side tutor");
	const selectors = override[1]!.split(",").map((s) => s.trim()).filter(Boolean);
	assert.deepEqual(selectors, [
		'[data-session-surface] [data-side-tutor] [data-streamdown="inline-code"]',
		"[data-session-surface] [data-side-tutor] .lh-nobreak",
		"[data-session-surface] [data-side-tutor] :not(.katex-display) > .katex",
		"[data-session-surface] [data-side-tutor] .lh-nobreak .katex",
	]);
	assert.match(override[2]!, /display: inline;/);
	assert.match(override[2]!, /white-space: inherit;/);
	assert.match(override[2]!, /overflow: visible;/);
	assert.match(override[2]!, /max-width: none;/);
	// It comes after the upstream rules it undoes (same or higher specificity).
	assert.ok(GLOBALS_CSS.indexOf("[data-side-tutor]") > GLOBALS_CSS.indexOf("[data-session-surface] .lh-nobreak .katex {"));
});
