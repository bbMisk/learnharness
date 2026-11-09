import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMenuPlacement, type MenuSide } from "../components/menu-shell.tsx";

/**
 * The shared menu shell's placement decision (fix wave chunk B): the
 * pure math behind every dropdown's anchoring — side preference, the
 * honest-fit flip, the 60vh cap, alignment. The DOM effects (portal,
 * measure-then-show, re-placement on scroll/resize) are live-verified;
 * this pins the geometry.
 */

const rect = (top: number, bottom: number) => ({ top, bottom, left: 100, right: 300 });
const viewport = (height: number) => ({ width: 1280, height });

describe("computeMenuPlacement — side", () => {
	it("keeps the preferred side when it shows the whole menu", () => {
		for (const preferred of ["up", "down"] as MenuSide[]) {
			const p = computeMenuPlacement(rect(400, 440), viewport(800), 300, preferred, "right");
			assert.equal(p.side, preferred);
		}
	});

	it("flips when the preferred side cannot hold the content and the other is roomier", () => {
		// Anchor 30px above the viewport bottom: down has ~2px of room,
		// up has ~380. A 300px menu must flip UP despite preferring down.
		const p = computeMenuPlacement(rect(770, 800), viewport(800), 300, "down", "right");
		assert.equal(p.side, "up");
		// ...and mirrors: an anchor at the very top preferring up flips down.
		const q = computeMenuPlacement(rect(0, 30), viewport(800), 300, "up", "right");
		assert.equal(q.side, "down");
	});

	it("stays put when neither side fits better (the roomier side already preferred)", () => {
		// Short viewport: down has 450, up has 200 — a 600px menu stays
		// down (capped gracefully) because up is NOT roomier.
		const p = computeMenuPlacement(rect(150, 190), viewport(650), 600, "down", "right");
		assert.equal(p.side, "down");
	});

	it("nothing measured yet (contentHeight ≤ 0) keeps the preferred side", () => {
		const p = computeMenuPlacement(rect(770, 800), viewport(800), 0, "down", "right");
		assert.equal(p.side, "down");
	});
});

describe("computeMenuPlacement — cap + position", () => {
	it("caps at 60vh when the side has more room than that", () => {
		// Anchor high: 648px below it — more than 60vh(480) → the cap is 60vh.
		const p = computeMenuPlacement(rect(100, 140), viewport(800), 300, "down", "right");
		assert.equal(p.maxHeight, 0.6 * 800);
		assert.equal(p.style.top, 144); // anchor bottom + GAP(4)
		assert.equal(p.style.right, 1280 - 300); // right-aligned to the anchor
	});

	it("caps at the side's available room when 60vh exceeds it", () => {
		// Anchor at 500/800: down room = 800 − 8 − 544 = 248 < 480. The
		// short content (100) fits down — no flip — so the cap binds at 248.
		const p = computeMenuPlacement(rect(500, 540), viewport(800), 100, "down", "right");
		assert.equal(p.side, "down");
		assert.equal(p.maxHeight, 248);
	});

	it("never crushes below the usability floor, even against a tiny side", () => {
		// Anchor 30px above the bottom, both sides thin: capped to the
		// floor, not a 2px sliver — the cap overflows rather than crushes.
		const p = computeMenuPlacement(rect(30, 60), viewport(90), 300, "down", "right");
		assert.equal(p.maxHeight, 96);
	});

	it("up-side menus anchor their BOTTOM above the anchor's top", () => {
		const p = computeMenuPlacement(rect(400, 440), viewport(800), 300, "up", "right");
		assert.equal(p.style.bottom, 800 - 400 + 4); // viewport − anchor.top − GAP
		assert.ok(!("top" in p.style));
	});

	it("left alignment keys off the anchor's left edge", () => {
		const p = computeMenuPlacement(rect(400, 440), viewport(800), 300, "down", "left");
		assert.equal(p.style.left, 100);
		assert.ok(!("right" in p.style));
	});
});
it("safe-area insets are not usable room (iPad Home Screen app)", () => {
	const anchor = { top: 300, bottom: 340, left: 100, right: 200 };
	const vp = { width: 1180, height: 768 };
	// An upward menu near the top never reaches into the 24px status bar.
	const up = computeMenuPlacement(anchor, vp, 600, "up", "right", { top: 24, bottom: 20 });
	assert.ok(up.side === "down" || up.maxHeight <= anchor.top - 24, `up menu stays below the status bar (max ${up.maxHeight})`);
	// Downward room shrinks by exactly the 20px home-indicator inset.
	const low = { top: 100, bottom: 140, left: 100, right: 200 };
	const plain = computeMenuPlacement(low, vp, 2000, "down", "right");
	const safe = computeMenuPlacement(low, vp, 2000, "down", "right", { top: 24, bottom: 20 });
	assert.equal(safe.side, "down");
	assert.ok(plain.maxHeight - safe.maxHeight <= 20 && safe.maxHeight <= plain.maxHeight);
	// A menu that stays above its anchor is capped by the status bar: 200 - 4 - 8 = 188 → 164 with a 24px inset.
	const short = { width: 1180, height: 400 };
	const midAnchor = { top: 200, bottom: 240, left: 100, right: 200 };
	assert.equal(computeMenuPlacement(midAnchor, short, 300, "up", "right").maxHeight, 188);
	const capped = computeMenuPlacement(midAnchor, short, 300, "up", "right", { top: 24, bottom: 20 });
	assert.equal(capped.side, "up");
	assert.equal(capped.maxHeight, 164, "the menu's top edge stays 8px below the status bar");
	// Tiny viewport: the 96px usability floor never pushes into the home indicator.
	const tiny = computeMenuPlacement({ top: 110, bottom: 150, left: 10, right: 60 }, { width: 500, height: 260 }, 300, "down", "right", { top: 24, bottom: 21 });
	assert.ok(150 + 4 + tiny.maxHeight <= 260 - 21, `menu bottom ${150 + 4 + tiny.maxHeight} stays above the inset`);
	// Landscape notch: a right-aligned menu never extends left of the safe edge.
	const notch = computeMenuPlacement({ top: 100, bottom: 140, left: 300, right: 380 }, { width: 852, height: 393 }, 200, "down", "right", { top: 0, bottom: 21, left: 59, right: 59 });
	assert.equal(notch.style.maxWidth, 380 - 59 - 8, "max width stops 8px inside the left inset");
	assert.equal(computeMenuPlacement({ top: 100, bottom: 140, left: 300, right: 380 }, { width: 852, height: 393 }, 200, "down", "right").style.maxWidth, 380 - 8, "no side insets: capped at the viewport edge only");
	// iPad split view (320px, no side insets): a menu anchored near the right edge stays on screen.
	const split = computeMenuPlacement({ top: 100, bottom: 140, left: 250, right: 292 }, { width: 320, height: 700 }, 200, "down", "right", { top: 24, bottom: 20, left: 0, right: 0 });
	assert.equal(split.style.maxWidth, 292 - 8, "a 352px menu is narrowed to fit left of its anchor");
	// Zero insets: identical to before.
	assert.deepEqual(computeMenuPlacement(anchor, vp, 300, "up", "right", { top: 0, bottom: 0 }), computeMenuPlacement(anchor, vp, 300, "up", "right"));
});

it("a menu without room on its side sits against the safe edge instead of shrinking (graph node near the edge)", () => {
	const nearLeft = computeMenuPlacement({ top: 100, bottom: 100, left: 20, right: 20 }, { width: 1000, height: 800 }, 200, "down", "right");
	assert.equal(nearLeft.style.left, 8);
	assert.equal(nearLeft.style.right, undefined);
	assert.ok((nearLeft.style.maxWidth as number) >= 160);
	const roomy = computeMenuPlacement({ top: 100, bottom: 100, left: 600, right: 600 }, { width: 1000, height: 800 }, 200, "down", "right");
	assert.equal(roomy.style.right, 400);
});


it("an anchor resized or rotated off-screen places the menu inside the viewport", () => {
	// Desktop: the last sidebar row at y 648–704, the window shrunk to 480 tall.
	const below = computeMenuPlacement(rect(648, 704), viewport(480), 335, "down", "right");
	assert.equal(below.side, "up");
	assert.equal(below.style.bottom, 4, "the menu's bottom sits GAP above the viewport's bottom");
	assert.equal(below.maxHeight, 0.6 * 480);
	// Phone: a drawer row at y 516 after rotating to 844×390, with a home indicator.
	const rotated = computeMenuPlacement({ top: 516, bottom: 560, left: 20, right: 280 }, { width: 844, height: 390 }, 234, "down", "right", { top: 0, bottom: 21 });
	assert.equal(rotated.side, "up");
	assert.equal(rotated.style.bottom, 21 + 4, "above the home indicator");
	assert.ok(390 - (rotated.style.bottom as number) - rotated.maxHeight >= 0, "the top edge is on-screen");
	// Scrolled above the top: the menu opens down from the top edge.
	const above = computeMenuPlacement(rect(-120, -80), viewport(800), 300, "up", "right");
	assert.equal(above.side, "down");
	assert.equal(above.style.top, 4);
	// A visible anchor is placed as before.
	assert.deepEqual(computeMenuPlacement(rect(770, 800), viewport(800), 300, "down", "right").style.bottom, 800 - 770 + 4);
});

describe("computeMenuPlacement — real DOMRect anchors", () => {
	// A DOMRect keeps left/right/top/bottom as prototype getters, so `{ ...rect }` drops
	// them. This class mirrors that shape; a plain-object rect would hide the bug.
	class GetterRect {
		#l: number; #t: number; #r: number; #b: number;
		constructor(l: number, t: number, r: number, b: number) { this.#l = l; this.#t = t; this.#r = r; this.#b = b; }
		get left() { return this.#l; } get top() { return this.#t; } get right() { return this.#r; } get bottom() { return this.#b; }
	}
	it("keeps the menu beside its anchor horizontally", () => {
		const viewport = { width: 1440, height: 900 };
		for (const align of ["left", "right"] as const) {
			const p = computeMenuPlacement(new GetterRect(877, 700, 997, 730), viewport, 200, "up", align);
			const style = p.style as Record<string, unknown>;
			const edge = align === "left" ? style.left : style.right;
			assert.equal(typeof edge, "number", align);
			assert.ok(align === "left" ? edge === 877 : edge === viewport.width - 997, `${align} edge follows the anchor, got ${String(edge)}`);
		}
	});
});
