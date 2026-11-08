import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { abortExtraction, extractionStatuses } from "../agent/subagents/extraction.ts";
import { isJobLive } from "../agent/subagents/aborts.ts";
import { coverageOf, storedCoverageSlots } from "../core/coverage.ts";
import { deleteChatTraces, type ChatDeleteMode, type ChatDeletionStats } from "../core/graph-deletion.ts";
import { titleFromPrompt, type ChatRecord, type ChatSettings } from "../core/contracts.ts";
import { emit } from "../core/events.ts";
import { graphRevision } from "./graph.ts";
import { clampChatLevel, validateChatSettings } from "./model-catalog.ts";
import { parseSettingsBody } from "./settings-body.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { clearTurnFailure } from "./turn-runs.ts";
import { discardChatDeliveries } from "./jobs.ts";

/**
 * Server-side chat entries for the transport layer (app/api/chats*,
 * app/chat/[id]). Today these delegate straight to the ChatStore port; the
 * services stage carves the real orchestration behind this same surface.
 *
 * deleteChatSession (wave 6, session deletion — the FIRST destructive
 * operation on the graph ledgers) is the one real orchestration here:
 * gates → extraction wind-down → one synchronous deletion block. See
 * core/graph-deletion.ts for the ledger semantics and the atomicity
 * argument.
 */

export const { createChat, getChat, listChats } = stores.chatStore;
export { titleFromPrompt };
export type { ChatDeleteMode, ChatDeletionStats } from "../core/graph-deletion.ts";

/** How long the wind-down wait may take before the caller gets a retryable
 *  503 (an aborted extraction ends at its next model-call boundary —
 *  provider cancellation is normally sub-second, but a wedged provider
 *  must never wedge deletion). */
const WIND_DOWN_TIMEOUT_MS = 10_000;
const WIND_DOWN_POLL_MS = 50;

/** What deleteChatSession did — the route maps it straight to HTTP. */
export type ChatDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "turn_in_flight" | "jobs_running"; error: string; jobIds: string[] }
	| { ok: false; status: 503; code: "extraction_winding_down"; error: string }
	| {
			ok: true;
			mode: ChatDeleteMode;
			stats: ChatDeletionStats;
			jobsRemoved: number;
			graphRevision: number;
	  };

/**
 * Delete a session (owner rulings 2026-09-22/23): gates first, then the
 * purge. The owner-locked choreography:
 *
 *   1. GATES — a turn in flight or a running background job refuses with
 *      409 (they write the chat record and steer into it; deleting
 *      mid-flight would corrupt the write-ahead flow). The UI retries once
 *      work drains.
 *   2. EXTRACTION WIND-DOWN — the chat's own pipeline run is TRUE-
 *      CANCELLED (abortExtraction: spend stops, nothing merges), then
 *      awaited off the registry. A timeout is a retryable 503, never a
 *      forced race.
 *   3. THE SYNC BLOCK — everything below runs without a single await:
 *      no extraction append can interleave (the event loop never yields
 *      mid-block), so the read-filter-write of the ledger rewrites is
 *      atomic against the pipeline. Ledgers first, jobs next, the chat
 *      record LAST (a crash mid-block leaves a deletable chat with a
 *      purged graph — re-running DELETE fixes it — never a deleted chat
 *      with live traces). The pipeline's per-batch liveness guard
 *      (extraction.ts) closes the last window: a run that slipped past
 *      the wind-down finds the chat gone at its merge and aborts with
 *      nothing merged.
 */
export function runningWorkBlocker(chatId: string): Extract<ChatDeleteOutcome, { status: 409 }> | null {
	if (isTurnRunning(chatId)) {
		return {
			ok: false,
			status: 409,
			code: "turn_in_flight",
			error: "A turn is running in this session — try again when it finishes",
			jobIds: [],
		};
	}
	// Legacy records kept completed workers running until delivery. A saved
	// result without a live loop is pending session data, not computing work;
	// deletion must not depend on a prior recovery poll to recognize it.
	const runningJobs = stores.jobStore.listJobs(chatId).filter((job) =>
		job.status === "running" && (!job.result || isJobLive(job.id)));
	if (runningJobs.length > 0) {
		return {
			ok: false,
			status: 409,
			code: "jobs_running",
			error: "Background jobs are still running in this session — try again when they finish",
			jobIds: runningJobs.map((job) => job.id),
		};
	}
	return null;
}

export async function deleteChatSession(chatId: string, mode: ChatDeleteMode): Promise<ChatDeleteOutcome> {
	if (!stores.chatStore.getChat(chatId)) {
		return { ok: false, status: 404, code: "not_found", error: "No such session" };
	}
	const blocker = runningWorkBlocker(chatId);
	if (blocker) return blocker;
	if (extractionStatuses().some((run) => run.chatId === chatId)) {
		abortExtraction(chatId); // true cancellation — spend stops, nothing merges
		const deadline = Date.now() + WIND_DOWN_TIMEOUT_MS;
		while (extractionStatuses().some((run) => run.chatId === chatId)) {
			if (Date.now() > deadline) {
				return {
					ok: false,
					status: 503,
					code: "extraction_winding_down",
					error: "The session's extraction is still winding down — try again in a moment",
				};
			}
			await new Promise((resolve) => setTimeout(resolve, WIND_DOWN_POLL_MS));
		}
	}

	// A result wake or a worker may have started during extraction wind-down.
	// Recheck immediately before the synchronous purge, with no await gap.
	const lateBlocker = runningWorkBlocker(chatId);
	if (lateBlocker) return lateBlocker;

	return finishChatDeletion(chatId, mode);
}

/** Source deletion has already purged the selected batch's graph traces.
 * Remove the remaining session data with the same gates/cleanup and no await. */
export function deleteIdleChatRecord(chatId: string): Extract<ChatDeleteOutcome, { ok: false }> | { ok: true } {
	if (!stores.chatStore.getChat(chatId)) return { ok: false, status: 404, code: "not_found", error: "No such session" };
	const blocker = runningWorkBlocker(chatId);
	if (blocker) return blocker;
	if (extractionStatuses().some((run) => run.chatId === chatId)) return { ok: false, status: 503, code: "extraction_winding_down", error: "The session's extraction is still winding down — try again in a moment" };
	finishChatRecordDeletion(chatId);
	// ChatStore can swallow unlink failures. Do not tell source deletion to
	// discard placement/folders while the conversation still exists.
	if (stores.chatStore.getChat(chatId)) throw new Error("Could not remove the selected session record.");
	return { ok: true };
}

function finishChatDeletion(chatId: string, mode: ChatDeleteMode): Extract<ChatDeleteOutcome, { ok: true }> {
	// THE SYNC BLOCK — no awaits below (see the doc comment). Order:
	// ledgers → jobs → the chat record.
	const stats = deleteChatTraces(stores.graphStore, chatId, mode);
	const jobsRemoved = finishChatRecordDeletion(chatId);
	return { ok: true, mode, stats, jobsRemoved, graphRevision: graphRevision() };
}

function finishChatRecordDeletion(chatId: string): number {
	const jobsRemoved = stores.jobStore.deleteJobsForChat(chatId);
	if (stores.chatStore.deleteChat(chatId)) {
		discardChatDeliveries(chatId);
		clearTurnFailure(chatId);
	}
	return jobsRemoved;
}

/** One session's coverage read (extraction-UX redesign, owner dispatch
 *  2026-09-24): the chat view's ring meter + popover data, scoped to one
 *  chat (the all-sessions GET died with this redesign — nothing consumed
 *  it once the sidebar and ring read here; the Extract POST stays).
 *  Uncovered stays DERIVED per request (fingerprint the transcript,
 *  diff the coverage ledger — never dual-tracked).
 *
 *  lastFoldedAt: the newest coverage row's fold timestamp — a cheap single
 *  pass over the chat's ledger rows (the ring popover's "last extraction"
 *  line); null before the session's first fold. */
export interface SessionCoverage {
	totalMessages: number;
	coveredCount: number;
	uncoveredCount: number;
	coveredTokens: number;
	uncoveredTokens: number;
	/** True while a chat-kind extraction run is registered for this session. */
	running: boolean;
	/** ISO of the newest fold in this session's coverage rows; null before any. */
	lastFoldedAt: string | null;
}

/** The per-session coverage block (see SessionCoverage). Null when the
 *  chat doesn't exist — callers own the 404. */
export function sessionCoverage(record: ChatRecord | null): SessionCoverage | null {
	if (!record) return null;
	const chatId = record.id;
	const entries = stores.graphStore.readChatCoverage(chatId);
	// Wave B: the record is native history — coverage reads through the
	// projection (same view the extraction pipeline folds). The record
	// comes from the chat store, so its message fingerprints memoize.
	const cov = coverageOf(record.messages, entries, chatId, storedCoverageSlots);
	let lastFoldedAt: string | null = null;
	for (const entry of entries) {
		if (entry.chatId !== chatId) continue;
		if (lastFoldedAt === null || entry.foldedAt > lastFoldedAt) lastFoldedAt = entry.foldedAt;
	}
	return {
		totalMessages: cov.slots.length,
		coveredCount: cov.coveredCount,
		uncoveredCount: cov.uncoveredCount,
		coveredTokens: cov.coveredTokens,
		uncoveredTokens: cov.uncoveredTokens,
		running: extractionStatuses().some((run) => run.kind === "chat" && run.chatId === chatId),
		lastFoldedAt,
	};
}

/** What updateChatSettings did — the route maps it straight to HTTP
 *  (`supported` rides only a catalog rejection, and only when set). */
export type ChatSettingsUpdate =
	| { ok: true; settings: ChatSettings }
	| { ok: false; status: 400 | 404; error: string; supported?: ThinkingLevel[] };

/**
 * The per-chat settings write (PUT /api/chats/[id]/settings) — the model
 * control (model-control wave) and the lesson's question type (owner,
 * 2026-11-03). PER-SESSION MODELS (owner, 2026-09-28): this is THE
 * in-session writer — the composer's control binds the session's own
 * record; the strong slot is only the birth default and never reaches an
 * existing session again.
 *
 * FIELD-LEVEL writes (fix, 2026-11-03): `body` names the fields it changes
 * and they merge into the CURRENT record (see mergeChatSettings). The model
 * picker sends a model pick as the pair and a level change as
 * { thinkingLevel } alone, the Qs chip only `questionType`, so none can
 * restore another's older value; a full object still replaces every group
 * it names. Unknown keys are dropped; `{}` changes nothing.
 *
 * Validation is the catalog gate (src/server/model-catalog.ts): a model the
 * write CHANGES must be in the catalog (unknown provider/model is a 400);
 * the saved model re-sent unchanged is never re-checked
 * (validateModelsSettings' discipline). Thinking levels never reject (owner,
 * interlude 2026-09-22): a pinned level clamps to the named model's
 * nearest supported and the clamped value is stored. The model pair is
 * checked and clamped only when the write names it: a question-type write
 * leaves a stored pin exactly as it was. Effective next turn by
 * construction (agents are stateless per turn).
 *
 * THE WRITE BOUNDARY: synchronous end to end — nothing awaits between
 * reading the current record and saving the merge, so a write that landed
 * while this body was still arriving is the base, never lost and never
 * compared against a stale snapshot. Open views of the chat (other tabs,
 * other devices) refetch its settings on the narrow `chat-settings-changed`
 * event — the transcript did not change.
 */
export function updateChatSettings(id: string, body: unknown): ChatSettingsUpdate {
	const parsed = parseSettingsBody(body);
	if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
	const chat = getChat(id);
	if (!chat) return { ok: false, status: 404, error: "Not found" };
	const merged = mergeChatSettings(chat.settings, body, parsed.settings);
	let settings = merged;
	if (namesModelPair(body)) {
		if (!sameModel(merged.model, chat.settings?.model)) {
			const verdict = validateChatSettings(merged);
			if (!verdict.ok) return { ok: false, status: 400, error: verdict.error, supported: verdict.supported };
		}
		// Clamp-on-write: against the merged model, else the record's strong slot.
		settings = clampChatLevel(merged, effectiveSettings().models.strong);
	}
	stores.chatStore.saveSettings(id, settings);
	emit("chat-settings-changed", { chatId: id });
	return { ok: true, settings };
}

function asRecord(body: unknown): Record<string, unknown> {
	return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** Does the body name the model pair ({model, thinkingLevel})? */
function namesModelPair(body: unknown): boolean {
	const raw = asRecord(body);
	return "model" in raw || "thinkingLevel" in raw;
}

/** The FIELD-LEVEL merge: the parsed body's fields applied onto the CURRENT
 *  record's settings, each group only when the body names it:
 *  - `model` named → the pair comes from the body (an absent level is
 *    cleared — the picker's {model} still drops a stale level);
 *  - only `thinkingLevel` named → the level changes on the CURRENT saved
 *    model, so a window holding an older model can never write it back;
 *  - `questionType`.
 *  Anything else the record holds rides through. */
function mergeChatSettings(current: ChatSettings | undefined, body: unknown, parsed: ChatSettings): ChatSettings {
	const raw = asRecord(body);
	const out: ChatSettings = { ...current };
	if ("model" in raw) {
		delete out.model;
		delete out.thinkingLevel;
		if (parsed.model) out.model = parsed.model;
		if (parsed.thinkingLevel !== undefined) out.thinkingLevel = parsed.thinkingLevel;
	} else if ("thinkingLevel" in raw) {
		delete out.thinkingLevel;
		if (parsed.thinkingLevel !== undefined) out.thinkingLevel = parsed.thinkingLevel;
	}
	if (parsed.questionType !== undefined) out.questionType = parsed.questionType;
	return out;
}

function sameModel(a: ChatSettings["model"], b: ChatSettings["model"]): boolean {
	return a?.provider === b?.provider && a?.id === b?.id;
}
