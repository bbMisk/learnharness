import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LH_DATA_DIR = mkdtempSync(join(tmpdir(), "lh-new-page-"));
const { default: NewSessionPage } = await import("../app/chat/new/page.tsx");
const { projectStore } = await import("../src/server/projects.ts");

it("/chat/new?mode= opens every session mode, unknown ones as Teach", async () => {
	const modeOf = async (mode?: string) => ((await NewSessionPage({ searchParams: Promise.resolve({ mode }) })) as React.ReactElement<{ mode: string }>).props.mode;
	assert.equal(await modeOf("cram"), "cram");
	assert.equal(await modeOf("practice"), "practice");
	assert.equal(await modeOf("teach"), "teach");
	assert.equal(await modeOf("bogus"), "teach");
	assert.equal(await modeOf(undefined), "teach");
});

it("/chat/new?project= for a deleted or unknown project is a 404; a live one opens", async () => {
	const open = (project: string) => NewSessionPage({ searchParams: Promise.resolve({ project }) });
	await assert.rejects(open("project_nope"), (error: { digest?: string }) => String(error.digest).includes("404"));
	const live = projectStore.create("Real Analysis");
	assert.equal(((await open(live.id)) as React.ReactElement<{ projectId: string }>).props.projectId, live.id);
});

it("/chat/new remounts per project (its own draft) but not per mode", async () => {
	const keyOf = async (project?: string, mode?: string) => (await NewSessionPage({ searchParams: Promise.resolve({ project, mode }) }) as React.ReactElement).key;
	const a = projectStore.create("A"), b = projectStore.create("B");
	const keys = [await keyOf(), await keyOf(a.id), await keyOf(b.id)];
	assert.equal(new Set(keys).size, 3);
	assert.equal(await keyOf(a.id, "practice"), await keyOf(a.id, "cram"));
	assert.equal(await keyOf(undefined, "cram"), await keyOf());
});
