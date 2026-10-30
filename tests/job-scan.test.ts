import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { after, afterEach, mock, test } from "node:test";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-job-scan-"));
process.env.LH_DATA_DIR = directory;
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { activityFeed } = await import("../src/server/observability.ts");
const { discardChatDeliveries, setJobRespawn, listJobsForChats } = await import("../src/server/jobs.ts");
const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
const created: string[] = [];
function chat(title: string) { const c = chatStore.createChat(title); created.push(c.id); return c; }
afterEach(() => { for (const id of created.splice(0)) { discardChatDeliveries(id); chatStore.deleteChat(id); } fs.rmSync(path.join(directory, "jobs"), { recursive: true, force: true }); });
after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("job enumeration can scan all files while scoped reads retain their ordering", () => {
	const a = chat("A"), b = chat("B");
	const first = jobStore.createJob({ kind: "research", chatId: a.id, toolCallId: "first" });
	const other = jobStore.createJob({ kind: "research", chatId: b.id, toolCallId: "other" });
	const later = jobStore.createJob({ kind: "research", chatId: a.id, toolCallId: "later" });
	jobStore.updateJob(first.id, { updatedAt: "2026-01-01T00:00:00Z" });
	jobStore.updateJob(later.id, { updatedAt: "2026-01-02T00:00:00Z" });
	const broken = path.join(directory, "jobs", "broken.json");
	fs.writeFileSync(broken, "{");
	try {
		assert.deepEqual(jobStore.listJobs(a.id).map(j => j.id), [later.id, first.id]);
		assert.deepEqual(new Set(jobStore.listJobs().map(j => j.id)), new Set([first.id, later.id, other.id]));
	} finally { fs.unlinkSync(broken); }
});

test("activity scans each job file once and preserves legacy task, delivery, ties and orphan filtering", () => {
	const a = chat("A"), b = chat("B");
	chatStore.saveMessages(a.id, [{ ...fauxAssistantMessage([
		fauxToolCall("research", { question: "Legacy task" }, { id: "legacy" }),
		fauxToolCall("quiz", { question: "Pending" }, { id: "question" }),
	]), id: "calls" }]);
	const one = jobStore.createJob({ kind: "research", chatId: a.id, toolCallId: "legacy" });
	jobStore.updateJob(one.id, { result: { brief: "Ready", sources: [] }, updatedAt: "2026-01-01T00:00:00Z" });
	const two = jobStore.createJob({ kind: "research", chatId: b.id, toolCallId: "second" });
	jobStore.updateJob(two.id, { task: "Current task", updatedAt: "2026-01-01T00:00:00Z" });
	const done = jobStore.createJob({ kind: "research", chatId: b.id, toolCallId: "done" });
	jobStore.updateJob(done.id, { status: "done" });
	const orphan = jobStore.createJob({ kind: "research", chatId: "missing-chat", toolCallId: "orphan" });
	const order = chatStore.listChats().map(c => c.id);
	const read = fs.readFileSync; let reads = 0;
	const spy = mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
		if (path.dirname(String(args[0])) === path.join(directory, "jobs")) reads++;
		return read(...args);
	});
	syncBuiltinESMExports();
	try {
		const feed = activityFeed().jobs;
		assert.deepEqual(feed.map(j => j.id), order.flatMap(id => id === a.id ? [one.id] : id === b.id ? [two.id] : []));
		assert.equal(feed.find(j => j.id === one.id)!.task, "Legacy task");
		assert.equal(feed.find(j => j.id === one.id)!.deliveryState, "waiting-answer");
		assert.equal(feed.find(j => j.id === two.id)!.title, "B");
		assert.equal(reads, 4, "each stored job is parsed once, regardless of chat count");
	} finally { spy.mock.restore(); syncBuiltinESMExports(); fs.unlinkSync(path.join(directory, "jobs", orphan.id + ".json")); }
});

test("one chat's invalid timestamp cannot hide another chat's jobs", () => {
	const a = chat("Bad"), b = chat("Good");
	const malformed = jobStore.createJob({ kind: "research", chatId: a.id, toolCallId: "bad" });
	const another = jobStore.createJob({ kind: "research", chatId: a.id, toolCallId: "another" });
	const file = path.join(directory, "jobs", malformed.id + ".json");
	fs.writeFileSync(file, JSON.stringify({ ...malformed, updatedAt: null }));
	fs.writeFileSync(path.join(directory, "jobs", another.id + ".json"), JSON.stringify({ ...another, updatedAt: null }));
	const good = jobStore.createJob({ kind: "research", chatId: b.id, toolCallId: "good" });
	assert.deepEqual(activityFeed().jobs.map(j => j.id), [good.id]);
});

test("activity returns the fresh state after lazy recovery changes a job", () => {
	const c = chat("Recovery");
	const j = jobStore.createJob({ kind: "research", chatId: c.id, toolCallId: "recover" });
	const environment = process.env as Record<string, string | undefined>;
	const previous = environment.NODE_ENV;
	const global = globalThis as { __lhWakePipeline?: { lastSweepAt: number } };
	if (global.__lhWakePipeline) global.__lhWakePipeline.lastSweepAt = 0;
	setJobRespawn(id => { assert.equal(id, j.id); jobStore.updateJob(id, { status: "done" }); });
	environment.NODE_ENV = "production";
	try { assert.deepEqual(activityFeed().jobs, []); assert.equal(jobStore.getJob(j.id)!.status, "done"); }
	finally { environment.NODE_ENV = previous; setJobRespawn(() => {}); }
});

	test("batching preserves a malformed non-running singleton just like scoped enumeration", () => {
	const c = chat("Singleton"); const j = jobStore.createJob({ kind: "research", chatId: c.id, toolCallId: "single" });
	fs.writeFileSync(path.join(directory, "jobs", j.id + ".json"), JSON.stringify({ ...j, status: "done", updatedAt: null }));
	assert.deepEqual(listJobsForChats([c.id]).get(c.id), jobStore.listJobs(c.id).map(job => ({ ...job, task: undefined, deliveryState: undefined })));
	});
