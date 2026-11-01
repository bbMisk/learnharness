import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { questionArrivalExpanded, revealArrival, shouldStampGeometryMute } from "../components/chat.tsx";

/**
 * The geometry-mute's growth rule (flicker round, 2026-09-26): reserve
 * GROWTH while a question is pending is the dock stretching itself (the
 * dictation flush landing many dictated lines at once, reproduced d≈152 >
 * COLLAPSE_DIST) — the spacer's scroll catch-up must not read as the
 * learner leaving. Shrinks are the fold's own give-back and never stamp.
 */
describe("shouldStampGeometryMute — when a block resize is our own stretch", () => {
	it("growth while a question is pending stamps (dictation flush, arrival stretch)", () => {
		assert.equal(shouldStampGeometryMute(545, 393, true), true);
	});

	it("sub-pixel growth does not stamp (rounding noise)", () => {
		assert.equal(shouldStampGeometryMute(394, 393, true), false);
	});

	it("shrink never stamps — the fold's own morph must not self-mute the re-expand", () => {
		assert.equal(shouldStampGeometryMute(40, 545, true), false);
	});

	it("no growth stamps without a pending question (composer life)", () => {
		assert.equal(shouldStampGeometryMute(545, 393, false), false);
	});
});

describe("question arrival — teaching checks and assessment questions", () => {
	it("opens automatically while following the tutor at the bottom", () => {
		assert.equal(questionArrivalExpanded(true), true);
	});

	it("stays minimized while reading earlier messages", () => {
		assert.equal(questionArrivalExpanded(false), false);
	});
});

/** A check behind the reveal (Settings → Reveal questions; cram mode by default). */
describe("revealArrival — how a check that waits for Enter or a click lands", () => {
	it("fresh arrival after the composer: collapsed behind the reveal button", () => {
		assert.deepEqual(revealArrival(false), { expanded: false, revealed: false });
	});
	it("queued behind another question: open — the reading already happened", () => {
		assert.deepEqual(revealArrival(true), { expanded: true, revealed: true });
	});
});
