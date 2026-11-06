/**
 * The plan marginalia's flank (components/dock-flank.ts; Codex round 1,
 * 2026-11-05): with no room made it is exactly the pre-card geometry; while
 * the Progress card makes room it starts MARGIN_GAP right of the SHIFTED
 * dock and ends MARGIN_GAP left of the card's lane, and its width (the fade
 * floor's input) is the real gap between the two. Pure numbers, plus the
 * chat's wiring.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { it } from "node:test";
import { DOCK_W, MARGIN_GAP, MARGIN_MIN_W, dockFlank, measureDockFlank } from "../components/dock-flank.ts";

/** Resolve the flank's `calc(50% + Npx)` left against a block width. */
const leftPx = (left: string, blockWidth: number) => {
	const m = left.match(/^calc\(50% \+ (-?[\d.]+)px\)$/);
	assert.ok(m, `unexpected left: ${left}`);
	return blockWidth / 2 + Number(m[1]);
};

// The room padding (lesson-tracker.tsx TRACKER_ROOM_DOCK): the column's
// 1.5rem gutter left, 18.25rem right — the card's lane is the difference,
// the card (w-64, 256px) plus its edge gap (right-3, 12px).
const PL = 24;
const PR = 292;
const CARD_LANE = 256 + 12;

it("no room: exactly the pre-card geometry", () => {
	for (const w of [900, 1280, 1440, 1920]) {
		const f = dockFlank(w, 0, 0);
		assert.equal(f.lane, 0);
		assert.equal(f.left, `calc(50% + ${DOCK_W / 2 + MARGIN_GAP}px)`, "the old left");
		assert.equal(f.right, 16, "the old right-4");
		assert.equal(f.width, Math.round(w / 2 - DOCK_W / 2 - 2 * MARGIN_GAP), "the old flank width");
	}
});

it("room made: the flank runs from the shifted dock's edge to the card's lane, MARGIN_GAP from each", () => {
	assert.equal(PR - PL, CARD_LANE);
	for (const w of [1440, 1600, 1920, 2560]) {
		const f = dockFlank(w, PL, PR);
		assert.equal(f.lane, CARD_LANE);
		// The dock: centred in the padded content box (the column's), 46rem wide.
		const dockRight = PL + (w - PL - PR) / 2 + DOCK_W / 2;
		const left = leftPx(f.left, w);
		assert.equal(left, dockRight + MARGIN_GAP, `${w}: MARGIN_GAP right of the shifted dock`);
		const cardLeft = w - CARD_LANE;
		assert.equal(w - f.right, cardLeft - MARGIN_GAP, `${w}: MARGIN_GAP left of the card`);
		assert.equal(f.width, Math.round(w - f.right - left), `${w}: the width is the real gap`);
	}
	// The fade floor sees the narrower flank: at 1440 there is no room beside
	// both the dock and the card, at 1920 there is.
	assert.ok(dockFlank(1440, PL, PR).width < MARGIN_MIN_W);
	assert.ok(dockFlank(1920, PL, PR).width >= MARGIN_MIN_W);
	assert.ok(dockFlank(1440, 0, 0).width >= MARGIN_MIN_W, "unshifted, 1440 had a flank");
});

it("measures the block's live padding", () => {
	const g = globalThis as { getComputedStyle?: unknown };
	const before = g.getComputedStyle;
	g.getComputedStyle = () => ({ paddingLeft: "24px", paddingRight: "292px" });
	try {
		assert.deepEqual(measureDockFlank({ offsetWidth: 1920 } as HTMLElement), dockFlank(1920, PL, PR));
		g.getComputedStyle = () => ({ paddingLeft: "0px", paddingRight: "0px" });
		assert.deepEqual(measureDockFlank({ offsetWidth: 1920 } as HTMLElement), dockFlank(1920, 0, 0));
	} finally {
		g.getComputedStyle = before;
	}
});

it("the chat positions the marginalia from the measured flank and re-measures when the room changes", () => {
	const chat = fs.readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
	assert.match(chat, /const next = measureDockFlank\(block\);/);
	assert.match(chat, /style=\{\{ left: flank\.left, right: flank\.right \}\}/);
	assert.match(chat, /expanded && flankW >= MARGIN_MIN_W/);
	assert.match(chat, /ro\.observe\(block\);\s*return \(\) => ro\.disconnect\(\);\s*\}, \[room\]\);/);
	assert.doesNotMatch(chat, /right-4 top-0 cursor-pointer/, "no fixed right edge left behind");
});
