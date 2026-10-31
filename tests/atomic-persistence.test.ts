import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it, mock } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-atomic-persistence-"));
process.env.LH_DATA_DIR = root;
const { SETTINGS_FILE, PATHS } = await import("../config.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { subscribe } = await import("../src/core/events.ts");
after(() => fs.rmSync(root, { recursive: true, force: true }));

for (const failure of ["partial write", "rename"] as const) {
	it(`failed ${failure} preserves saved settings, chats and jobs without notifying success`, () => {
		writeSettings({ version: 1, graph: { enabled: false } });
		const chat = chatStore.createChat("Keep this lesson");
		const job = jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "demo1" });
		const records = [
			{ file: SETTINGS_FILE, save: () => writeSettings({ version: 1, graph: { enabled: true } }) },
			{ file: path.join(PATHS.chats, chat.id + ".json"), save: () => chatStore.renameChat(chat.id, "Changed") },
			{ file: path.join(PATHS.data, "jobs", job.id + ".json"), save: () => jobStore.updateJob(job.id, { activity: "Changed" }) },
		];
		const before = records.map(({ file }) => fs.readFileSync(file, "utf8"));
		const events: unknown[] = [];
		const off = subscribe(event => events.push(event));
		try {
			if (failure === "partial write") {
				const write = fs.writeFileSync;
				mock.method(fs, "writeFileSync", (file: fs.PathOrFileDescriptor) => {
					write(file, "{");
					throw new Error("fixture partial write");
				});
			} else mock.method(fs, "renameSync", () => { throw new Error("fixture rename"); });
			for (const { save } of records) assert.throws(save, /fixture/);
		} finally { mock.restoreAll(); off(); }
		assert.deepEqual(records.map(({ file }) => fs.readFileSync(file, "utf8")), before);
		assert.equal(events.length, 0);
		assert.equal(readSettings()?.graph?.enabled, false);
		assert.equal(chatStore.getChat(chat.id)?.title, chat.title);
		assert.equal(jobStore.getJob(job.id)?.activity, job.activity);
		for (const { file } of records) assert.ok(!fs.readdirSync(path.dirname(file)).some(name => name.endsWith(".tmp")));
	});
}

it("successful replacements retain restricted file permissions and publish only complete records", () => {
	writeSettings({ version: 1, graph: { enabled: false } });
	fs.chmodSync(SETTINGS_FILE, 0o600);
	writeSettings({ version: 1, graph: { enabled: true } });
	assert.equal(fs.statSync(SETTINGS_FILE).mode & 0o777, 0o600);
	let completeAtNotification = false;
	const off = subscribe(event => {
		if (event.type === "jobs-changed") completeAtNotification = jobStore.listJobs(event.chatId).some(job => job.toolCallId === "demo2" && job.status === "running");
	});
	try { jobStore.createJob({ kind: "demo", chatId: "chat_atomic", toolCallId: "demo2" }); }
	finally { off(); }
	assert.ok(completeAtNotification);
	assert.equal(readSettings()?.graph?.enabled, true);
});

it("replacement preserves existing permissions even under a more restrictive umask", () => {
	writeSettings({ version: 1, graph: { enabled: false } });
	fs.chmodSync(SETTINGS_FILE, 0o660);
	const previous = process.umask(0o077);
	try { writeSettings({ version: 1, graph: { enabled: true } }); }
	finally { process.umask(previous); }
	assert.equal(fs.statSync(SETTINGS_FILE).mode & 0o777, 0o660);
});

it("an explicit mode replaces the saved mode; fsync and exclusive create are opt-in", async () => {
	const { writeFileAtomic } = await import("../src/store/write-file.ts");
	const file = path.join(root, "explicit-mode.json");
	fs.writeFileSync(file, "old");
	fs.chmodSync(file, 0o644);
	const previous = process.umask(0o022);
	const opens: unknown[] = [];
	let fsyncs = 0;
	try {
		const open = fs.openSync, fsync = fs.fsyncSync;
		mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { opens.push(args.slice(1)); return open(...args); });
		mock.method(fs, "fsyncSync", (fd: number) => { fsyncs++; fsync(fd); });
		writeFileAtomic(file, "new", { mode: 0o600, fsync: true, exclusive: true });
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		writeFileAtomic(file, "plain");
	} finally { mock.restoreAll(); process.umask(previous); }
	assert.deepEqual(opens, [["wx", 0o600], ["w", 0o100600]]);
	assert.equal(fsyncs, 1);
	assert.equal(fs.readFileSync(file, "utf8"), "plain");
	assert.ok(!fs.readdirSync(root).some(name => name.endsWith(".tmp")));
});
