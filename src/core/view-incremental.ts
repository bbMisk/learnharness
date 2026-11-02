/**
 * THE INCREMENTAL VIEW PROJECTOR: projectView's exact output, with work per
 * update proportional to the changing tail instead of the whole history.
 *
 * A streaming reply replaces only the record's LAST message (~10 updates a
 * second), yet projectView re-projects every message on every update. The
 * projector keeps a CHECKPOINT: the fold state after the previous call's
 * messages — all but the last while that one streams, since each update
 * replaces it. The next call resumes from it when
 *
 *   1. the checkpoint's messages are still the record's prefix, by identity
 *      (the session model replaces a changed message, never edits one), and
 *   2. nothing in the new tail changes how the prefix projected:
 *      - a compaction marker moves the cut divider (projectView reads the
 *        record's ACTIVE compaction);
 *      - a send_to_user failure turns an earlier output call's prose into
 *        an error part;
 *      - a clean problem acknowledgement can change an earlier conclude
 *        card's reveal (problemInputForConclude);
 *      - the live layer: an execution or streaming flag for a prefix call
 *        or message must be the same object/flag the checkpoint saw.
 *
 * Anything else falls back to the full fold, which also lays a fresh
 * checkpoint. Everything that legitimately reaches back into earlier rows
 * during the tail's fold (a tool result attaching to an older call, the
 * group merge of consecutive assistant messages, a plan block splicing into
 * the preceding group) goes through the fold's copy-on-write, so cached
 * rows are never mutated and untouched rows keep their identity from one
 * update to the next — which is what lets the transcript skip re-rendering
 * them (components/transcript-rows.tsx).
 */

import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { activeCompactionOf } from "./compaction.ts";
import {
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	SEND_TO_USER_TOOL,
	type LhMarkerMessage,
	type LhMessage,
} from "./native-messages.ts";
import {
	foldViewMessage,
	outputErrorsOf,
	type ActiveCompaction,
	type LhViewMessage,
	type LiveExecution,
	type LiveTurnState,
	type ViewFoldContext,
	type ViewFoldState,
} from "./view.ts";

/** The fold state after `prefix`, plus what the prefix's projection read. */
interface Checkpoint {
	prefix: readonly LhMessage[];
	/** Never mutated: the next pass copies the array and copy-on-writes rows. */
	out: readonly LhViewMessage[];
	/** Shared with the fold (a superset of the tool part ids in `out`). */
	toolPartIds: Set<string>;
	compaction: ActiveCompaction;
	/** send_to_user failures among the prefix messages (last wins). */
	outputErrors: Map<string, ToolResultMessage>;
	sendCallIds: Set<string>;
	problemCallIds: Set<string>;
	/** Call ids with a clean (non-error) result in the prefix. */
	cleanIds: Set<string>;
	hasConclude: boolean;
	callIds: Set<string>;
	messageIds: Set<string>;
	/** The live layer the prefix projected with. */
	executions: Map<string, LiveExecution>;
	streaming: Set<string>;
}

function emptyCheckpoint(compaction: ActiveCompaction): Checkpoint {
	return {
		prefix: [],
		out: [],
		toolPartIds: new Set(),
		compaction,
		outputErrors: new Map(),
		sendCallIds: new Set(),
		problemCallIds: new Set(),
		cleanIds: new Set(),
		hasConclude: false,
		callIds: new Set(),
		messageIds: new Set(),
		executions: new Map(),
		streaming: new Set(),
	};
}

/** Record what message `m` (now part of the prefix) makes the prefix read. */
function remember(cp: Checkpoint, m: LhMessage, live: LiveTurnState | undefined): void {
	cp.messageIds.add(m.id);
	if (live?.streamingIds.has(m.id)) cp.streaming.add(m.id);
	if (m.role === "assistant") {
		for (const block of m.content) {
			if (block.type !== "toolCall") continue;
			cp.callIds.add(block.id);
			const execution = live?.executions.get(block.id);
			if (execution) cp.executions.set(block.id, execution);
			if (block.name === SEND_TO_USER_TOOL) cp.sendCallIds.add(block.id);
			else if (block.name === PRACTICE_PROBLEM_TOOL) cp.problemCallIds.add(block.id);
			else if (block.name === PRACTICE_CONCLUDE_TOOL) cp.hasConclude = true;
		}
	} else if (m.role === "toolResult") {
		if (!m.isError) cp.cleanIds.add(m.toolCallId);
		else if (m.toolName === SEND_TO_USER_TOOL) cp.outputErrors.set(m.toolCallId, m);
	}
}

/** Would appending `m` after the prefix change how the prefix projects? */
function reachesBack(cp: Checkpoint, m: LhMessage): boolean {
	if (m.role === "custom") {
		const marker = m as LhMarkerMessage;
		return (
			marker.customType === "compaction" &&
			typeof (marker.details as { firstKeptMessageId?: unknown } | undefined)?.firstKeptMessageId === "string"
		);
	}
	if (m.role !== "toolResult") return false;
	if (m.isError) return m.toolName === SEND_TO_USER_TOOL && cp.sendCallIds.has(m.toolCallId);
	return cp.hasConclude && cp.problemCallIds.has(m.toolCallId) && !cp.cleanIds.has(m.toolCallId);
}

/** Does the live layer project the prefix exactly as it did when cached? */
function sameLive(cp: Checkpoint, live: LiveTurnState | undefined): boolean {
	for (const [id, execution] of cp.executions) if (live?.executions.get(id) !== execution) return false;
	for (const id of cp.streaming) if (!live?.streamingIds.has(id)) return false;
	if (!live) return true;
	for (const id of live.executions.keys()) if (cp.callIds.has(id) && !cp.executions.has(id)) return false;
	for (const id of live.streamingIds) if (cp.messageIds.has(id) && !cp.streaming.has(id)) return false;
	return true;
}

function resumable(cp: Checkpoint, messages: readonly LhMessage[], live: LiveTurnState | undefined): boolean {
	const k = cp.prefix.length;
	if (k > messages.length) return false;
	for (let i = k - 1; i >= 0; i--) if (messages[i] !== cp.prefix[i]) return false;
	for (let i = k; i < messages.length; i++) if (reachesBack(cp, messages[i]!)) return false;
	return sameLive(cp, live);
}

export interface ViewProjector {
	/** projectView(messages, live), reusing the previous call's prefix. */
	project(messages: readonly LhMessage[], live?: LiveTurnState): LhViewMessage[];
}

export function createViewProjector(): ViewProjector {
	let checkpoint: Checkpoint | null = null;
	return {
		project(messages, live) {
			const previous = checkpoint;
			checkpoint = null; // a throw mid-fold must not leave a half-extended cache
			const n = messages.length;
			if (n === 0) return [];
			let cp: Checkpoint;
			let state: ViewFoldState;
			let ctx: ViewFoldContext;
			if (previous && resumable(previous, messages, live)) {
				cp = previous;
				state = { out: cp.out.slice(), owned: new WeakSet(), toolPartIds: cp.toolPartIds };
				const tailErrors = outputErrorsOf(messages.slice(cp.prefix.length));
				ctx = {
					messages,
					live,
					compaction: cp.compaction,
					outputError: (id) => tailErrors.get(id) ?? cp.outputErrors.get(id),
				};
			} else {
				cp = emptyCheckpoint(activeCompactionOf(messages));
				state = { out: [], owned: null, toolPartIds: cp.toolPartIds };
				const outputErrors = outputErrorsOf(messages);
				ctx = { messages, live, compaction: cp.compaction, outputError: (id) => outputErrors.get(id) };
			}
			const start = cp.prefix.length;
			// The next checkpoint: every message, or every message but the
			// last while that one streams (each update replaces it).
			const last = messages[n - 1]!;
			const end = Math.max(start, live?.streamingIds.has(last.id) ? n - 1 : n);
			for (let i = start; i < end; i++) {
				foldViewMessage(state, ctx, messages[i]!);
				remember(cp, messages[i]!, live);
			}
			// Its rows are frozen from here on: later folds copy-on-write.
			const next: Checkpoint = start === end ? cp : { ...cp, prefix: messages.slice(0, end), out: state.out.slice() };
			if (end < n) {
				if (state.owned === null || start !== end) state.owned = new WeakSet();
				foldViewMessage(state, ctx, last);
				if (reachesBack(next, last)) return state.out;
			}
			checkpoint = next;
			return state.out;
		},
	};
}
