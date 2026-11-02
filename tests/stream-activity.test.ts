/**
 * toolActivityLabel (2026-09-19, the "Writing a question…" fix): a tool
 * stays input-streaming for its WHOLE execution, so the live tool card
 * must name the ACTUAL running tool — the old code shimmered "Writing a
 * question…" over minutes-long greps.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toolActivityLabel } from "../src/core/pending.ts";

describe("toolActivityLabel (the live tool card's label)", () => {
	it("question tools keep their question shimmer", () => {
		assert.equal(toolActivityLabel("quiz"), "Writing a question…");
		assert.equal(toolActivityLabel("ask_user_question"), "Writing a question…");
	});

	it("local tools name their actual activity", () => {
		assert.equal(toolActivityLabel("grep"), "Searching file contents…");
		assert.equal(toolActivityLabel("read"), "Reading a file…");
		assert.equal(toolActivityLabel("find"), "Finding files…");
		assert.equal(toolActivityLabel("ls"), "Listing a directory…");
	});

	it("job dispatch tools get their own labels; unknown tools stay generic", () => {
		assert.equal(toolActivityLabel("pdf"), "Reading a PDF…");
		assert.equal(toolActivityLabel("mystery_tool"), "Working…");
	});
});
