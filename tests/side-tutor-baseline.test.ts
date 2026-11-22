/**
 * FORK: with the default side-chat switch ("tutor", src/core/fork-config.ts)
 * the model-facing prompts, the Settings prompt-segment list, the keyboard
 * shortcut list and the model roles equal the snapshot taken before
 * upstream's side questions came back as switched-off code
 * (tests/fixtures/side-tutor-baseline.json).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

process.env.LH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-side-tutor-baseline-"));
delete process.env.LH_FORK_SIDE_CHAT;
const baseline = JSON.parse(fs.readFileSync(new URL("./fixtures/side-tutor-baseline.json", import.meta.url), "utf8"));
const { forkSideChat } = await import("../src/core/fork-config.ts");
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { allSegmentPaths, listSourceSegments } = await import("../src/agent/prompt-segments.ts");
const { KEYBOARD_ACTIONS } = await import("../src/core/keyboard.ts");
const { MODEL_SLOTS } = await import("../src/core/settings.ts");

const kinds = ["prober", "teacher", "practice"] as const;

describe("the default side-chat switch keeps the app as it was", () => {
	it("defaults to the side tutor", () => assert.equal(forkSideChat, "tutor"));

	for (const kind of kinds) {
		it(`composes the ${kind} prompt byte-identically`, () => {
			assert.equal(composeInstructions(kind), baseline.prompts[kind]);
			assert.doesNotMatch(composeInstructions(kind), /learner–helper|side conversation/i);
		});
	}

	it("lists the same prompt segments in Settings", () => {
		for (const kind of kinds) assert.deepEqual(listSourceSegments(kind).map((s) => s.path), baseline.segments[kind], kind);
		assert.deepEqual(allSegmentPaths(), baseline.allSegmentPaths);
	});

	it("offers the same keyboard shortcuts", () => {
		assert.deepEqual(JSON.parse(JSON.stringify(KEYBOARD_ACTIONS)), baseline.keyboardActions);
	});

	it("offers the same model slots", () => {
		assert.deepEqual([...MODEL_SLOTS], ["strong", "cheap", "vision"]);
	});
});
