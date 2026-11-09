import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LH_DATA_DIR = mkdtempSync(join(tmpdir(), "lh-new-page-"));
const { default: NewSessionPage } = await import("../app/chat/new/page.tsx");

it("/chat/new?mode= opens every session mode, unknown ones as Teach", async () => {
	const modeOf = async (mode?: string) => ((await NewSessionPage({ searchParams: Promise.resolve({ mode }) })) as React.ReactElement<{ mode: string }>).props.mode;
	assert.equal(await modeOf("cram"), "cram");
	assert.equal(await modeOf("practice"), "practice");
	assert.equal(await modeOf("teach"), "teach");
	assert.equal(await modeOf("bogus"), "teach");
	assert.equal(await modeOf(undefined), "teach");
});
