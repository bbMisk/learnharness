/**
 * ChatStore — the fs JSON adapter (one file per chat in data/chats/).
 *
 * Implements core/ports.ts ChatStore; the record shapes live in
 * core/contracts.ts (ChatRecord/ChatSummary). Idioms: sync fs, tiny
 * records, id-guarded filenames, JSON with tab indentation. Wired in the
 * composition root (src/server/stores.ts); nothing else constructs it.
 */

import * as fs from "node:fs";
import { writeFileAtomic } from "./write-file.ts";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { mergeLearningEvents } from "../core/learning-history.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import type { ChatRecord, ChatSettings, ChatSummary, ExtractionRunUsage, PlanTree, TurnUsage } from "../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { activeProblemOf, danglingQuestionOf } from "../core/native-messages.ts";
import { phaseAt3Lh } from "../core/phases.ts";

function chatFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	return path.join(PATHS.chats, `${id}.json`);
}

/** THE SILENCE LAW (push S6, 2026-10-02): chats-changed announces ONLY
 *  list-SHAPE mutations — createChat, renameChat, deleteChat (below,
 *  each emits post-write). The content writers (saveMessages,
 *  appendTurnUsage, appendExtractionUsage, saveSettings, saveTree) are
 *  DELIBERATELY SILENT: saveMessages fires per turn-persist and would
 *  spam the bus, and every list-visible change it causes (title, order,
 *  phase, busy, pendingQuestion) is already announced by turn-started /
 *  turn-settled, which the sidebar refetches on. Silence here is law,
 *  not oversight. */
function createChat(title: string, kind?: "practice"): ChatRecord {
	const now = new Date().toISOString();
	const record: ChatRecord = {
		id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: title.trim() || "Untitled session",
		createdAt: now,
		updatedAt: now,
		messages: [],
		// Practice sessions carry the marker; teach stays ABSENT (absence
		// reads as teach — pre-practice records never migrate).
		...(kind === "practice" ? { kind: "practice" as const } : {}),
	};
	fs.mkdirSync(PATHS.chats, { recursive: true });
	writeChat(record);
	emit("chats-changed", {});
	return { ...record, version: CURRENT_CHAT_VERSION }; // the in-memory twin of what landed on disk
}

/** THE WRITE CHOKE POINT (schema-versioning wave, owner 2026-10-10): every
 *  record persist goes through here and carries the CURRENT version stamp —
 *  lazy migration means existing files only get stamped on their next write.
 *  A future-version guard lives on the read side (getChat). The record
 *  cache keeps what was written, so the next read does not parse it. */
function writeChat(record: ChatRecord): void {
	const file = chatFile(record.id);
	const stamped = { ...record, version: CURRENT_CHAT_VERSION };
	const json = JSON.stringify(stamped, null, "\t");
	const previous = recordCache.get(record.id)?.record;
	forgetRecord(record.id);
	writeFileAtomic(file, json);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		return; // the next getChat reads the file
	}
	if (stat.size > RECORD_CACHE_BYTES) return;
	rememberRecord(record.id, signatureOf(stat), stat.size, writtenRecord(stamped, json, previous));
}

/** What a fresh parse of the file writeChat just wrote returns, without
 *  parsing it: values the previous cached record already holds are cache-
 *  owned and reused as they are; every other value goes through JSON, so
 *  the cache shares nothing the caller still holds and keeps nothing JSON
 *  drops or transforms (undefined, Dates). */
function writtenRecord(stamped: ChatRecord, json: string, previous: ChatRecord | undefined): ChatRecord {
	if (!previous) return JSON.parse(json) as ChatRecord;
	const owned = new Set<unknown>();
	for (const value of Object.values(previous)) {
		if (Array.isArray(value)) for (const item of value) owned.add(item);
		else owned.add(value);
	}
	const viaJson = (value: unknown): unknown => {
		if (owned.has(value)) return value;
		const text = JSON.stringify(value);
		return text === undefined ? undefined : JSON.parse(text);
	};
	const record: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(stamped)) {
		const copy = Array.isArray(value) ? Array.from(value, (item) => viaJson(item) ?? null) : viaJson(value);
		if (copy !== undefined) record[key] = copy;
	}
	return record as unknown as ChatRecord;
}

/** Parsed records keyed by id, valid while the file's stat signature holds
 *  (the same signature as the summary cache below). Only successful reads
 *  and writes are cached; least recently used records go first once the files they
 *  came from pass RECORD_CACHE_BYTES. Callers get a fresh top level and
 *  fresh top-level arrays, so they can replace fields and push or splice
 *  freely; everything deeper is shared and must be copied before it is
 *  changed. Tests deep-freeze the cached copy so a deep change fails loudly. */
const recordCache = new Map<string, { signature: string; bytes: number; record: ChatRecord }>();
const RECORD_CACHE_BYTES = 32 * 1024 * 1024;
const FREEZE_CACHED_RECORDS = process.env.NODE_ENV === "test";
let recordCacheBytes = 0;

function signatureOf(stat: fs.Stats): string {
	return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function forgetRecord(id: string): void {
	const cached = recordCache.get(id);
	if (!cached) return;
	recordCache.delete(id);
	recordCacheBytes -= cached.bytes;
}

function rememberRecord(id: string, signature: string, bytes: number, record: ChatRecord): void {
	forgetRecord(id);
	if (bytes > RECORD_CACHE_BYTES) return;
	if (FREEZE_CACHED_RECORDS) deepFreeze(record);
	recordCache.set(id, { signature, bytes, record });
	recordCacheBytes += bytes;
	for (const [oldest, entry] of recordCache) {
		if (recordCacheBytes <= RECORD_CACHE_BYTES) break;
		recordCache.delete(oldest);
		recordCacheBytes -= entry.bytes;
	}
}

function deepFreeze(value: unknown): void {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreeze(child);
}

function copyRecord(record: ChatRecord): ChatRecord {
	const copy: Record<string, unknown> = { ...record };
	for (const [key, value] of Object.entries(copy)) if (Array.isArray(value)) copy[key] = [...value];
	return copy as unknown as ChatRecord;
}

function getChat(id: string): ChatRecord | null {
	let stat: fs.Stats | undefined;
	try {
		stat = fs.statSync(chatFile(id));
	} catch {
		// Missing or unstattable: the uncached read below decides.
	}
	const signature = stat && signatureOf(stat);
	const cached = recordCache.get(id);
	if (signature && cached?.signature === signature) {
		recordCache.delete(id); // most recently used goes last
		recordCache.set(id, cached);
		return copyRecord(cached.record);
	}
	const record = readChat(id);
	if (!record || !stat || !signature) {
		forgetRecord(id);
		return record;
	}
	rememberRecord(id, signature, stat.size, record);
	return copyRecord(record);
}

function readChat(id: string): ChatRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(chatFile(id), "utf-8"));
	} catch {
		return null;
	}
	// Honest refusal (owner ruling 2026-10-10): a record stamped NEWER than
	// this build (the downgrade scenario) reads as absent, never misparsed —
	// the next read-modify-write must not rewrite what it doesn't understand.
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_CHAT_VERSION) {
		console.error(`[chat ${id}] record stamped with schema version ${v} > ${CURRENT_CHAT_VERSION} — this app build is older; refusing to read it`);
		return null;
	}
	return parsed as ChatRecord;
}

/** Projection for the session list; null when the record is absent or fails to project. */
function summaryOf(id: string): ChatSummary | null {
	const record = getChat(id);
	if (!record) return null;
	// Archived chats are listed, not kept in memory: they are rarely opened,
	// and a cold list would otherwise hold every one of them parsed.
	if (record.archived) forgetRecord(id);
	const { messages, tree, turns, extractions, learningEvents, ...summary } = record;
	// Per-record isolation (Wave B): a record whose messages fail the
	// projection (e.g. pre-Wave-B UIMessage-format scratch — the
	// zero-back-compat wipe makes these "corrupt") must not blank the
	// whole sidebar — same isolation getChat's per-file catch gives.
	try {
		return {
			// turns and extractions stay out of the list payload (list =
			// summaries; usage aggregates ride the full record, the picker
			// never needs them).
			...summary,
			// Normalized kind: absent record field reads as teach.
			kind: summary.kind ?? "teach",
			messageCount: messages.length,
			// Record-derived status for the session picker: phase from the
			// transcript's explicit events (probe_done concluded / verdict
			// accepted — docs/probe-teach-split.md §4), pending question
			// from the native dangling-call scan. Wave D: both folds read
			// the NATIVE record (core/phases.ts phaseAt3Lh +
			// native-messages.ts danglingQuestionOf). Liveness (busy) is
			// NOT record-derived — the API route merges it (ChatListItem).
			phase: phaseAt3Lh(messages),
			pendingQuestion: danglingQuestionOf(messages) !== null,
			// Existing gap kept as-is: pendingProblem (activeProblemOf) is never projected.
		} as ChatSummary;
	} catch (err) {
		console.error(`[chat ${summary.id}] summary projection failed:`, err);
		return null;
	}
}

/** Summaries keyed by file, valid while the file's stat signature holds.
 *  App writes are atomic renames (new inode); ctime also changes on any
 *  in-place write, even one that preserves mtime. Only successful
 *  projections are cached, so a transient read failure retries next list. */
const summaryCache = new Map<string, { signature: string; summary: ChatSummary }>();

function listChats(): ChatSummary[] {
	try {
		fs.mkdirSync(PATHS.chats, { recursive: true });
		const files = fs.readdirSync(PATHS.chats).filter((f) => f.endsWith(".json"));
		const present = new Set(files);
		for (const file of summaryCache.keys()) if (!present.has(file)) summaryCache.delete(file);
		const summaries: ChatSummary[] = [];
		for (const file of files) {
			let signature: string;
			try {
				const stat = fs.statSync(path.join(PATHS.chats, file));
				signature = signatureOf(stat);
			} catch {
				summaryCache.delete(file);
				continue;
			}
			const cached = summaryCache.get(file);
			if (cached?.signature === signature) {
				summaries.push({ ...cached.summary });
				continue;
			}
			const summary = summaryOf(file.slice(0, -5));
			if (!summary) {
				summaryCache.delete(file);
				continue;
			}
			summaryCache.set(file, { signature, summary });
			summaries.push({ ...summary });
		}
		return summaries.sort((a, b) => Number(!!b.pinned)-Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}

/** Persist the full native message list (the record IS the agent state —
 *  Wave B: replay is state.messages = record.messages). SILENT by the
 *  events law — see the SILENCE LAW comment at createChat. */
function saveMessages(id: string, messages: LhMessage[]): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	const previous = mergeLearningEvents(record.learningEvents, record.messages);
	record.learningEvents = mergeLearningEvents(previous, messages);
	record.messages = messages;
	record.updatedAt = new Date().toISOString();
	writeChat(record);
}

/** Backfill existing timestamped facts without changing lesson activity dates. */
export function captureChatLearningHistory(id: string): number {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	const events = mergeLearningEvents(record.learningEvents, record.messages);
	const added = events.length - (record.learningEvents?.length ?? 0);
	if (added > 0) {
		record.learningEvents = events;
		writeChat(record);
	}
	return added;
}

/** Append one usage entry to the record's turn log — idempotent per
 * turn id: each REQUEST carries its own id, so a replay of the same turn's
 * persist appends once, while continuation turns (which share a response
 *  message id) each keep their usage. */
function appendTurnUsage(id: string, entry: TurnUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.turns = record.turns?.some((t) => t.id === entry.id)
		? record.turns
		: [...(record.turns ?? []), entry];
	writeChat(record);
}

/** Append one extraction-run usage entry to the record's extractions
 * log — idempotent per startedAt: a retry that reaches the append twice
 * (abort replays) does not double-count spend. */
function appendExtractionUsage(id: string, entry: ExtractionRunUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.extractions = record.extractions?.some((r) => r.startedAt === entry.startedAt)
		? record.extractions
		: [...(record.extractions ?? []), entry];
	writeChat(record);
}

/** Persist the per-chat model/thinking settings — replace-whole (the
 * picker sends the complete object; absent = config defaults). */
function saveSettings(id: string, settings: ChatSettings): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	// Like saveTree: a settings tweak is not conversation activity, so it
	// deliberately does NOT bump updatedAt (sidebar order must not churn).
	record.settings = settings;
	writeChat(record);
}

/** Rename a session (the header's click-to-edit title, 2026-09-17). Like
 * saveSettings, a rename is NOT conversation activity: updatedAt stays put
 * so sidebar order never churns. Same fallback as createChat — the empty
 * string becomes "Untitled session" (the API gate rejects it first; this
 * is the honest floor for any other caller). */
function renameChat(id: string, title: string): ChatRecord {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.title = title.trim() || "Untitled session";
	writeChat(record);
	emit("chats-changed", {});
	return record;
}

/** Delete the session record file entirely (session-deletion wave 6,
 *  owner 2026-09-22). False when the id is unknown — the route turns that
 *  into a 404. The record's graph traces and jobs are the route's
 *  choreography (core/graph-deletion.ts), not the store's. */
function deleteChat(id: string): boolean {
	try {
		forgetRecord(id);
		fs.unlinkSync(chatFile(id));
		emit("chats-changed", {}); // only a real removal — the present-entry law
		return true;
	} catch {
		return false; // never existed, already deleted, or unreadable — same answer
	}
}

/** Persist the session plan tree (plan tools call this in execute). */
function saveTree(id: string, tree: PlanTree): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.tree = tree;
	// Deliberately does NOT bump updatedAt: tree mutations piggyback on the
	// turn's saveMessages, and sidebar ordering shouldn't churn on tree edits.
	writeChat(record);
}

export const chatStore: ChatStore = {
	createChat,
	getChat,
	listChats,
	saveMessages,
	saveTree,
	saveSettings,
	renameChat,
	deleteChat,
	appendTurnUsage,
	appendExtractionUsage,
};

/** Organization does not count as lesson activity or rewrite conversation history. */
export function setChatOrganization(id: string, updates: { pinned?: boolean; archived?: boolean; projectId?: string | null; style?: "cram" | null }): ChatRecord {
 const record=getChat(id);if(!record) throw new Error('Chat not found.');
 if(updates.pinned!==undefined) record.pinned=updates.pinned;
 if(updates.archived!==undefined) record.archived=updates.archived;
 if(updates.projectId!==undefined) { if(updates.projectId===null) delete record.projectId;else record.projectId=updates.projectId; }
 if(updates.style!==undefined) { if(updates.style===null) delete record.style;else record.style=updates.style; }
 writeChat(record);if(record.archived) forgetRecord(id);emit('chats-changed',{});return record;
}

/** Whether a chat's parsed record is held in memory (tests). */
export function isChatCached(id: string): boolean {
	return recordCache.has(id);
}
