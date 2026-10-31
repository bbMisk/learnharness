/**
 * getChat record cache: a cached read must equal an uncached read of the
 * same file after every kind of write, including writes the cache did not
 * see (another process editing or replacing a record), and callers must
 * never be able to change what the next reader gets.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { after, describe, it, mock } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-record-cache-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore, captureChatLearningHistory, setChatOrganization } = await import("../src/store/chats.ts");
const { PATHS } = await import("../config.ts");

let fresh = 0;
/** A new module instance has an empty cache: the uncached reference. */
async function uncachedGet(id: string) {
	const mod = await import(`../src/store/chats.ts?fresh=${++fresh}`) as typeof import("../src/store/chats.ts");
	return mod.chatStore.getChat(id);
}

async function assertParity(id: string) {
	assert.deepEqual(chatStore.getChat(id), await uncachedGet(id));
}

/** Count reads of one chat file while fn runs. */
function chatFileReads(id: string, fn: () => void): number {
	let reads = 0;
	const realRead = fs.readFileSync;
	const counting = mock.method(fs, "readFileSync", ((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
		if (String(target).endsWith(`${id}.json`)) reads++;
		return (realRead as (...args: unknown[]) => unknown)(target, ...rest);
	}) as typeof fs.readFileSync);
	syncBuiltinESMExports();
	try {
		fn();
	} finally {
		counting.mock.restore();
		syncBuiltinESMExports();
	}
	return reads;
}

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

describe("getChat record cache", () => {
	it("reads an unchanged file once", () => {
		const a = chatStore.createChat("read once");
		chatStore.getChat(a.id);
		assert.equal(chatFileReads(a.id, () => {
			chatStore.getChat(a.id);
			chatStore.getChat(a.id);
		}), 0);
	});

	it("matches an uncached read across store writes", async () => {
		const a = chatStore.createChat("first");
		await assertParity(a.id);
		chatStore.saveMessages(a.id, [{ id: "m1", role: "user", content: "hello", timestamp: 1 }]);
		await assertParity(a.id);
		assert.equal(chatStore.getChat(a.id)?.messages.length, 1);
		chatStore.renameChat(a.id, "first renamed");
		await assertParity(a.id);
		chatStore.saveSettings(a.id, { thinkingLevel: "high" } as never);
		await assertParity(a.id);
		chatStore.appendTurnUsage(a.id, { id: "t1", messageId: "m1", at: "2026-01-01T00:00:00.000Z", model: "m", steps: [] });
		await assertParity(a.id);
		assert.equal(chatStore.getChat(a.id)?.turns?.length, 1);
		assert.equal(chatStore.deleteChat(a.id), true);
		assert.equal(chatStore.getChat(a.id), null);
		await assertParity(a.id);
	});

	it("keeps what every store write wrote, so the next read does not parse the file", async () => {
		const a = chatStore.createChat("write through");
		const file = path.join(PATHS.chats, `${a.id}.json`);
		async function assertWrittenThrough(write: () => void) {
			write();
			assert.equal(chatFileReads(a.id, () => {
				chatStore.getChat(a.id);
				chatStore.listChats();
			}), 0);
			await assertParity(a.id);
		}
		await assertWrittenThrough(() => {});
		// Values JSON drops or transforms must not survive in the cache.
		await assertWrittenThrough(() => chatStore.saveMessages(a.id, [
			{ id: "m1", role: "user", content: "hello", timestamp: 1, dropped: undefined, when: new Date(0) } as never,
		]));
		await assertWrittenThrough(() => chatStore.saveMessages(a.id, [
			...chatStore.getChat(a.id)!.messages,
			{ id: "m2", role: "user", content: "again", timestamp: 2 },
		]));
		await assertWrittenThrough(() => chatStore.appendTurnUsage(a.id, { id: "t1", messageId: "m1", at: "2026-01-01T00:00:00.000Z", model: "m", steps: [] }));
		await assertWrittenThrough(() => chatStore.appendExtractionUsage(a.id, { startedAt: "2026-01-01T00:00:00.000Z", steps: [] } as never));
		await assertWrittenThrough(() => chatStore.saveSettings(a.id, { thinkingLevel: "high", model: undefined } as never));
		await assertWrittenThrough(() => chatStore.renameChat(a.id, "write through renamed"));
		await assertWrittenThrough(() => chatStore.saveTree(a.id, { nodes: [{ id: "n1", title: "Node" }], edges: [], version: 1 }));
		await assertWrittenThrough(() => setChatOrganization(a.id, { pinned: true, projectId: "p1" }));
		await assertWrittenThrough(() => setChatOrganization(a.id, { projectId: null }));
		const { learningEvents: _dropped, ...withoutHistory } = JSON.parse(fs.readFileSync(file, "utf-8"));
		fs.writeFileSync(file, JSON.stringify(withoutHistory));
		await assertWrittenThrough(() => assert.ok(captureChatLearningHistory(a.id) > 0));
		const stamped = JSON.parse(fs.readFileSync(file, "utf-8")).version;
		assert.equal(typeof stamped, "number");
		assert.equal(chatStore.getChat(a.id)?.version, stamped);
	});

	it("shares nothing a writer still holds", () => {
		const a = chatStore.createChat("writer keeps its objects");
		const messages = [{ id: "m1", role: "user", content: "hello", timestamp: 1 }] as { id: string; role: "user"; content: string; timestamp: number }[];
		chatStore.saveMessages(a.id, messages);
		messages[0]!.content = "edited after the write";
		messages.push({ id: "m2", role: "user", content: "pushed after the write", timestamp: 2 });
		const renamed = chatStore.renameChat(a.id, "renamed");
		renamed.title = "edited after the rename";
		renamed.messages.splice(0);
		const record = chatStore.getChat(a.id)!;
		assert.equal(record.title, "renamed");
		assert.deepEqual(record.messages.map((m) => (m as { content: string }).content), ["hello"]);
		assert.throws(() => {
			(record.messages[0] as { content: string }).content = "edited in place";
		}, TypeError);
	});

	it("sees external edits, replacements and removals", async () => {
		const c = chatStore.createChat("external");
		chatStore.getChat(c.id);
		const file = path.join(PATHS.chats, `${c.id}.json`);

		// In-place rewrite (same inode), title of a different length.
		const record = JSON.parse(fs.readFileSync(file, "utf-8"));
		fs.writeFileSync(file, JSON.stringify({ ...record, title: "edited elsewhere, longer" }));
		assert.equal(chatStore.getChat(c.id)?.title, "edited elsewhere, longer");
		await assertParity(c.id);

		// Same-size replacement through rename (new inode).
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ ...record, title: "edited elsewhere, LONGER" }));
		fs.renameSync(tmp, file);
		assert.equal(chatStore.getChat(c.id)?.title, "edited elsewhere, LONGER");
		await assertParity(c.id);

		// A record from a newer build reads as absent, and is not remembered.
		fs.writeFileSync(file, JSON.stringify({ ...record, version: Number.MAX_SAFE_INTEGER }));
		const quiet = mock.method(console, "error", () => {});
		try {
			assert.equal(chatStore.getChat(c.id), null);
		} finally {
			quiet.mock.restore();
		}
		fs.writeFileSync(file, JSON.stringify(record));
		assert.equal(chatStore.getChat(c.id)?.title, "external");

		fs.rmSync(file);
		assert.equal(chatStore.getChat(c.id), null);
		await assertParity(c.id);
	});

	it("sees an in-place rewrite that keeps size and mtime", async () => {
		const e = chatStore.createChat("AAAA");
		const file = path.join(PATHS.chats, `${e.id}.json`);
		fs.utimesSync(file, 1_700_000_000, 1_700_000_000); // whole seconds restore exactly
		chatStore.getChat(e.id);
		const before = fs.statSync(file);
		fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace('"AAAA"', '"BBBB"'));
		fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
		const after = fs.statSync(file);
		assert.equal(after.size, before.size);
		assert.equal(after.mtimeMs, before.mtimeMs);
		assert.equal(chatStore.getChat(e.id)?.title, "BBBB");
		await assertParity(e.id);
	});

	it("returns copies whose top level and top-level arrays callers may change", () => {
		const d = chatStore.createChat("copy check");
		chatStore.saveMessages(d.id, [{ id: "m1", role: "user", content: "hello", timestamp: 1 }]);
		const first = chatStore.getChat(d.id)!;
		first.title = "mutated by a caller";
		first.messages.push({ id: "m2", role: "user", content: "pushed", timestamp: 2 });
		first.messages.splice(0, 1);
		const second = chatStore.getChat(d.id)!;
		assert.equal(second.title, "copy check");
		assert.deepEqual(second.messages.map((m) => m.id), ["m1"]);
	});

	it("refuses deeper changes under test, so a caller that makes one fails loudly", () => {
		const d = chatStore.createChat("frozen check");
		chatStore.saveMessages(d.id, [{ id: "m1", role: "user", content: "hello", timestamp: 1 }]);
		const record = chatStore.getChat(d.id)!;
		assert.throws(() => {
			(record.messages[0] as { content: string }).content = "edited in place";
		}, TypeError);
		assert.equal((chatStore.getChat(d.id)!.messages[0] as { content: string }).content, "hello");
	});

	it("retries a chat whose read failed transiently", () => {
		const f = chatStore.createChat("flaky read");
		const file = path.join(PATHS.chats, `${f.id}.json`);
		fs.writeFileSync(file, `${fs.readFileSync(file, "utf-8")}\n`); // written elsewhere: the next read goes to disk
		const realRead = fs.readFileSync;
		const failing = mock.method(fs, "readFileSync", ((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
			if (String(target).endsWith(`${f.id}.json`)) throw Object.assign(new Error("EMFILE"), { code: "EMFILE" });
			return (realRead as (...args: unknown[]) => unknown)(target, ...rest);
		}) as typeof fs.readFileSync);
		syncBuiltinESMExports();
		try {
			assert.equal(chatStore.getChat(f.id), null);
		} finally {
			failing.mock.restore();
			syncBuiltinESMExports();
		}
		assert.equal(chatStore.getChat(f.id)?.title, "flaky read");
	});
});
