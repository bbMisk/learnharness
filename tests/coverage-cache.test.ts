import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, it, mock } from "node:test";
import type { CoverageEntry } from "../src/core/contracts/graph.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

/**
 * The coverage read cache (GET /api/chats/[id]): the parsed coverage
 * ledger is cached by the file's stat signature and indexed by chat, and
 * a stored record's message fingerprints memoize per message object. Every
 * read must equal the uncached derivation — a fresh parse of the ledger
 * and coverageSlots over the transcript — whatever happened in between.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-coverage-cache-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
const { stores } = await import("../src/server/stores.ts");
const { sessionCoverage } = await import("../src/server/chats.ts");
const { coverageOf, coverageSlots } = await import("../src/core/coverage.ts");
const { LEDGER_FILES } = await import("../config.ts");
const ledger = LEDGER_FILES.coverage;

beforeEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(root);
	fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}\n");
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** The ledger as the pre-cache store read it: a fresh parse, strict shapes. */
function parsedLedger(): CoverageEntry[] {
	let raw: string;
	try {
		raw = fs.readFileSync(ledger, "utf-8");
	} catch {
		return [];
	}
	const out: CoverageEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const v = JSON.parse(line) as CoverageEntry;
			if (typeof v.chatId === "string" && typeof v.fp === "string" && typeof v.tokens === "number" && typeof v.foldedAt === "string") out.push(v);
		} catch {
			/* skipped, as the store skips it */
		}
	}
	return out;
}

/** sessionCoverage as it was before the cache: full ledger, fresh slots. */
function uncachedCoverage(chatId: string) {
	const entries = parsedLedger();
	const record = stores.chatStore.getChat(chatId)!;
	const cov = coverageOf(JSON.parse(JSON.stringify(record.messages)) as LhMessage[], entries, chatId);
	let lastFoldedAt: string | null = null;
	for (const entry of entries) if (entry.chatId === chatId && (lastFoldedAt === null || entry.foldedAt > lastFoldedAt)) lastFoldedAt = entry.foldedAt;
	return {
		totalMessages: cov.slots.length,
		coveredCount: cov.coveredCount,
		uncoveredCount: cov.uncoveredCount,
		coveredTokens: cov.coveredTokens,
		uncoveredTokens: cov.uncoveredTokens,
		running: false,
		lastFoldedAt,
	};
}

function assertMatchesUncached(chatId: string, label: string): void {
	const cached = sessionCoverage(stores.chatStore.getChat(chatId));
	assert.deepEqual(cached, uncachedCoverage(chatId), label);
	assert.deepEqual(stores.graphStore.readCoverage(), parsedLedger(), `${label}: readCoverage`);
	assert.deepEqual(
		stores.graphStore.readChatCoverage(chatId),
		parsedLedger().filter((e) => e.chatId === chatId),
		`${label}: readChatCoverage`,
	);
}

function teacher(id: string, text: string, callId: string): LhMessage {
	return {
		id,
		role: "assistant",
		stopReason: "toolUse",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: callId, name: "send_to_user", arguments: { message: `${text} (sent)` } },
		],
		timestamp: 1,
	} as unknown as LhMessage;
}

function sent(id: string, callId: string, isError: boolean): LhMessage {
	return { id, role: "toolResult", toolCallId: callId, toolName: "send_to_user", isError, content: [{ type: "text", text: "ok" }], timestamp: 1 } as unknown as LhMessage;
}

function seedChat(): string {
	const chat = stores.chatStore.createChat("Cached coverage");
	stores.chatStore.saveMessages(chat.id, [
		{ id: "u1", role: "user", content: "What is a limit?", timestamp: 1 } as unknown as LhMessage,
		teacher("a1", "A limit is the value a function approaches.", "c1"),
		sent("r1", "c1", false),
		teacher("a2", "Derivatives are limits of difference quotients.", "c2"),
		sent("r2", "c2", false),
		teacher("a3", "Integrals accumulate.", "c3"),
	]);
	const slots = coverageSlots(stores.chatStore.getChat(chat.id)!.messages);
	stores.graphStore.appendCoverage({ chatId: chat.id, fp: slots[1]!.fp, tokens: slots[1]!.tokens, foldedAt: "2026-10-01T00:00:00.000Z" });
	stores.graphStore.appendCoverage({ chatId: "other", fp: "f".repeat(64), tokens: 7, foldedAt: "2026-10-09T00:00:00.000Z" });
	stores.graphStore.appendCoverage({ chatId: chat.id, fp: slots[3]!.fp, tokens: slots[3]!.tokens, foldedAt: "2026-10-02T00:00:00.000Z" });
	return chat.id;
}

it("matches the uncached read across app writes, external edits and deletion", () => {
	const chatId = seedChat();
	assertMatchesUncached(chatId, "fresh read");
	assertMatchesUncached(chatId, "repeated read");
	assert.equal(sessionCoverage(stores.chatStore.getChat(chatId))?.coveredCount, 2);

	// App append.
	const slots = coverageSlots(stores.chatStore.getChat(chatId)!.messages);
	stores.graphStore.appendCoverage({ chatId, fp: slots[5]!.fp, tokens: slots[5]!.tokens, foldedAt: "2026-10-03T00:00:00.000Z" });
	assertMatchesUncached(chatId, "after appendCoverage");
	assert.equal(sessionCoverage(stores.chatStore.getChat(chatId))?.uncoveredCount, 0);

	// App rewrite (session deletion's atomic rename).
	stores.graphStore.rewriteLedgers({ coverage: parsedLedger().filter((e) => e.fp !== slots[3]!.fp) });
	assertMatchesUncached(chatId, "after rewriteLedgers");
	assert.equal(sessionCoverage(stores.chatStore.getChat(chatId))?.uncoveredCount, 1);

	// External in-place rewrite: same size, same inode, different mtime.
	const before = fs.statSync(ledger);
	const raw = fs.readFileSync(ledger, "utf-8");
	const edited = raw.replace(slots[1]!.fp, "0".repeat(64)).replace("2026-10-03", "2026-10-07");
	assert.equal(edited.length, raw.length);
	assert.notEqual(edited, raw);
	fs.writeFileSync(ledger, edited);
	fs.utimesSync(ledger, before.atime, new Date(before.mtimeMs + 5_000));
	const afterEdit = fs.statSync(ledger);
	assert.equal(afterEdit.size, before.size);
	assert.equal(afterEdit.ino, before.ino);
	assertMatchesUncached(chatId, "after same-size external rewrite with a new mtime");
	assert.equal(sessionCoverage(stores.chatStore.getChat(chatId))?.lastFoldedAt, "2026-10-07T00:00:00.000Z");

	// External in-place rewrite that also restores the old mtime: ctime still moves.
	const restored = fs.statSync(ledger);
	fs.writeFileSync(ledger, edited.replace("2026-10-07", "2026-10-08"));
	fs.utimesSync(ledger, restored.atime, restored.mtime);
	assert.equal(fs.statSync(ledger).mtimeMs, restored.mtimeMs);
	assertMatchesUncached(chatId, "after same-size, same-mtime external rewrite");
	assert.equal(sessionCoverage(stores.chatStore.getChat(chatId))?.lastFoldedAt, "2026-10-08T00:00:00.000Z");

	// Deleted ledger.
	fs.rmSync(ledger);
	assertMatchesUncached(chatId, "after deleting the ledger");
	assert.equal(sessionCoverage(stores.chatStore.getChat(chatId))?.coveredCount, 0);
	assert.equal(sessionCoverage(stores.chatStore.getChat(chatId))?.lastFoldedAt, null);

	// Recreated by the app.
	stores.graphStore.appendCoverage({ chatId, fp: slots[1]!.fp, tokens: slots[1]!.tokens, foldedAt: "2026-10-04T00:00:00.000Z" });
	assertMatchesUncached(chatId, "after recreating the ledger");
	assert.equal(sessionCoverage(stores.chatStore.getChat(chatId))?.coveredCount, 1);
});

it("re-derives a message whose prose changed or whose output call failed later", () => {
	const chatId = seedChat();
	assertMatchesUncached(chatId, "fresh read");

	// A later failed result for c2 drops a2's send_to_user prose; a2's
	// record object is reused by the write, so only the failure can tell.
	const record = stores.chatStore.getChat(chatId)!;
	const a2 = record.messages[3]!;
	stores.chatStore.saveMessages(chatId, record.messages.map((m) => (m.id === "r2" ? sent("r2", "c2", true) : m)));
	assert.equal(stores.chatStore.getChat(chatId)!.messages[3], a2, "the unchanged message keeps its object");
	assertMatchesUncached(chatId, "after a failed output result");
	assert.equal(sessionCoverage(stores.chatStore.getChat(chatId))?.coveredCount, 1);

	// Edited prose: a new message object.
	const edited = stores.chatStore.getChat(chatId)!.messages.map((m) => (m.id === "a1" ? teacher("a1", "A limit, restated.", "c1") : m));
	stores.chatStore.saveMessages(chatId, edited);
	assertMatchesUncached(chatId, "after editing prose");
	assert.equal(sessionCoverage(stores.chatStore.getChat(chatId))?.coveredCount, 0);
});

it("a repeated read neither re-parses the ledger nor re-fingerprints the transcript", () => {
	const chatId = seedChat();
	const first = sessionCoverage(stores.chatStore.getChat(chatId));
	const parse = mock.method(JSON, "parse");
	const stringify = mock.method(JSON, "stringify");
	try {
		const second = sessionCoverage(stores.chatStore.getChat(chatId));
		assert.deepEqual(second, first);
		const ledgerParses = parse.mock.calls.filter((call) => String(call.arguments[0]).includes('"fp"'));
		assert.equal(ledgerParses.length, 0, "no ledger line parsed");
		// messageFingerprint hashes JSON.stringify([role, viewLines]).
		const fingerprints = stringify.mock.calls.filter((call) => {
			const v = call.arguments[0];
			return Array.isArray(v) && v.length === 2 && Array.isArray(v[1]);
		});
		assert.equal(fingerprints.length, 0, "no message fingerprinted");
	} finally {
		parse.mock.restore();
		stringify.mock.restore();
	}
	// And a write is seen on the very next read, which parses again.
	stores.graphStore.appendCoverage({ chatId, fp: "e".repeat(64), tokens: 1, foldedAt: "2026-10-05T00:00:00.000Z" });
	const parse2 = mock.method(JSON, "parse");
	try {
		assert.equal(sessionCoverage(stores.chatStore.getChat(chatId))?.lastFoldedAt, "2026-10-05T00:00:00.000Z");
		assert.ok(parse2.mock.calls.some((call) => String(call.arguments[0]).includes('"fp"')), "the changed ledger is parsed");
	} finally {
		parse2.mock.restore();
	}
});

it("only shares frozen ledger rows through fresh copies", () => {
	const chatId = seedChat();
	const rows = stores.graphStore.readChatCoverage(chatId);
	rows[0]!.fp = "mutated";
	rows.push({ chatId, fp: "pushed", tokens: 1, foldedAt: "x" });
	stores.graphStore.readCoverage()[0]!.tokens = -1;
	assertMatchesUncached(chatId, "after callers mutate what they were given");
});
