/** Physics tuning on the live renderer: applying the saved tuning on load
 *  must not re-anneal (and re-save) the layout; a real change still does. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { GraphCanvasRenderer } from "../components/graph-canvas.ts";
import { DEFAULT_PHYSICS_TUNING } from "../src/core/render-settings.ts";

// The class is DOM-bound; drive the one method on a stub instance.
function stub() {
	const calls = { builds: 0, alphas: [] as number[] };
	const r = Object.create(GraphCanvasRenderer.prototype) as Record<string, unknown>;
	Object.assign(r, {
		physicsTuning: DEFAULT_PHYSICS_TUNING,
		simActive: false,
		dragPins: [],
		markDirty() {},
		buildSim(this: Record<string, unknown>) {
			calls.builds++;
			this.sim = { alpha(v: number) { calls.alphas.push(v); return this; } };
		},
	});
	return { r: r as unknown as { setPhysicsTuning: GraphCanvasRenderer["setPhysicsTuning"]; simActive: boolean }, calls };
}
const saved = { ...DEFAULT_PHYSICS_TUNING, depthMode: "vertical" as const, chargeStrength: -240 };

it("re-applying the tuning the renderer already has does nothing", () => {
	const { r, calls } = stub();
	r.setPhysicsTuning({ ...DEFAULT_PHYSICS_TUNING });
	assert.equal(calls.builds, 0);
	assert.equal(r.simActive, false);
});

it("the saved tuning applied on load rebuilds the sim without re-annealing", () => {
	const { r, calls } = stub();
	r.setPhysicsTuning(saved, false);
	assert.equal(calls.builds, 1);
	assert.deepEqual(calls.alphas, []);
	assert.equal(r.simActive, false);
});

it("a real tuning change re-anneals", () => {
	const { r, calls } = stub();
	r.setPhysicsTuning(saved);
	assert.deepEqual(calls.alphas, [1]);
	assert.equal(r.simActive, true);
});
