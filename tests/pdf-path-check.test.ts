import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { jobTools } from "../src/agent/tools/jobs.ts";
import type { JobStore } from "../src/core/ports.ts";
import type { JobRecord } from "../src/core/contracts.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pdf-path-"));
const pdf = path.join(dir, "notes.pdf");
fs.writeFileSync(pdf, "%PDF-1.4\n");

function setup(existing: JobRecord | null = null) {
	const spawned: JobRecord[] = [];
	const jobStore = {
		createJob: (init) => ({ id: `job_${spawned.length + 1}`, ...init, status: "running" }) as JobRecord,
		findJobByToolCallId: () => existing,
	} as Partial<JobStore> as JobStore;
	const tools = jobTools({ chatId: "c1", jobStore, spawn: (job) => spawned.push(job) });
	return { pdf: tools.pdf!, spawned };
}

it("a missing PDF path is rejected to the tutor without starting a job", async () => {
	const t = setup();
	const out = await t.pdf.execute!("call-1", { path: path.join(dir, "gone.pdf"), question: "q" });
	assert.equal(out.isError, true);
	assert.match((out.content[0] as { text: string }).text, /no file at .*gone\.pdf/);
	assert.equal(t.spawned.length, 0);
});

it("a folder is rejected too", async () => {
	const t = setup();
	const out = await t.pdf.execute!("call-2", { path: dir, question: "q" });
	assert.equal(out.isError, true);
	assert.match((out.content[0] as { text: string }).text, /is a folder/);
	assert.equal(t.spawned.length, 0);
});

it("an existing PDF dispatches a job", async () => {
	const t = setup();
	const out = await t.pdf.execute!("call-3", { path: pdf, question: "q" });
	assert.notEqual(out.isError, true);
	assert.match(String(out.details), /^Dispatched \(job job_1\)\./);
	assert.equal(t.spawned.length, 1);
});

it("a call that already has a job is not re-checked (its file may since have moved)", async () => {
	const job = { id: "job_9", kind: "pdf", chatId: "c1", toolCallId: "call-4", status: "done" } as JobRecord;
	const t = setup(job);
	const out = await t.pdf.execute!("call-4", { path: path.join(dir, "gone.pdf"), question: "q" });
	assert.match(String(out.details), /^Dispatched \(job job_9\)\./);
	assert.equal(t.spawned.length, 0);
});
