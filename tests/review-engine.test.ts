import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { it } from "node:test";
import { createReviewEngine } from "../src/core/review-engine.ts";
import type { FsrsStates, ReviewMemory } from "../src/core/review-engine.ts";

const bytes = await fs.readFile(new URL("../vendor/fsrs/engine.wasm", import.meta.url));
const engine = await createReviewEngine(bytes);
const vectors = JSON.parse(await fs.readFile(new URL("../vendor/fsrs/reference-vectors.json", import.meta.url), "utf8")) as { input: { memory: ReviewMemory | null; days: number; retention: number }; expected: FsrsStates }[];

it("matches the exact Anki-pinned Rust crate's native reference vectors", () => {
	for (const vector of vectors) {
		const actual = engine.nextStates(vector.input.memory, vector.input.days, vector.input.retention);
		for (const rating of ["again", "hard", "good", "easy"] as const) {
			for (const [a, b] of [[actual[rating].interval, vector.expected[rating].interval], [actual[rating].memory.stability, vector.expected[rating].memory.stability], [actual[rating].memory.difficulty, vector.expected[rating].memory.difficulty]]) {
				assert.ok(Math.abs(a! - b!) <= 0.00001 * Math.max(1, Math.abs(b!)), `${rating}: ${a} differs from upstream ${b}`);
			}
		}
	}
});

it("refuses a changed binary and reports invalid scheduling inputs", async () => {
	const changed = bytes.slice(); changed[0] = 1;
	await assert.rejects(createReviewEngine(changed), /integrity check/);
	assert.throws(() => engine.nextStates({ stability: -1, difficulty: 5 }, 1), /Invalid memory/);
	assert.throws(() => engine.nextStates(null, 0, 0), /Invalid retention/);
});
