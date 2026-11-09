/** The saved graph camera reopens centred at any canvas size: the world
 *  point at the old centre lands at the new centre. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { restoreCamera } from "../components/graph-view.tsx";

it("re-centres a camera saved at another canvas size", () => {
	const saved = JSON.stringify({ k: 0.5, x: 552.5, y: 661.5, w: 1200, h: 800 });
	assert.deepEqual(restoreCamera(saved, 1200, 800), { k: 0.5, x: 552.5, y: 661.5 });
	assert.deepEqual(restoreCamera(saved, 600, 500), { k: 0.5, x: 252.5, y: 511.5 });
	assert.deepEqual(restoreCamera(saved, 2400, 1400), { k: 0.5, x: 1152.5, y: 961.5 });
});

it("older entries without a size restore unchanged; corrupt ones fall back to fit", () => {
	assert.deepEqual(restoreCamera(JSON.stringify({ k: 1, x: 3, y: 4 }), 600, 500), { k: 1, x: 3, y: 4 });
	assert.equal(restoreCamera(null, 600, 500), null);
	assert.equal(restoreCamera("{", 600, 500), null);
	assert.equal(restoreCamera(JSON.stringify({ k: 0, x: 3, y: 4 }), 600, 500), null);
});
