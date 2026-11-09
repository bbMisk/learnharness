/** The header chip row scrolls sideways under a plain mouse wheel (QA: with
 *  the side tutor open below ~1280 px the hidden chips were unreachable). */
import assert from "node:assert/strict";
import { it } from "node:test";
import { sidewaysWheel } from "../components/sideways-wheel.ts";

it("a vertical wheel scrolls the row sideways; a horizontal swipe is left to the browser", () => {
	const row = { scrollLeft: 0 } as HTMLElement;
	sidewaysWheel({ deltaX: 0, deltaY: 120, currentTarget: row });
	assert.equal(row.scrollLeft, 120);
	sidewaysWheel({ deltaX: 40, deltaY: 5, currentTarget: row });
	assert.equal(row.scrollLeft, 120, "trackpad horizontal deltas scroll natively");
});

it("the chip row uses it", async () => {
	const chat = (await import("node:fs")).readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
	assert.match(chat, /onWheel=\{sidewaysWheel\} className="lh-scroll-fade/);
});
