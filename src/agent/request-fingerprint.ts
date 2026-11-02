/** Cache-miss diagnostics (2026-11-01): fingerprint the request a
 * conversation step really sends, so the saved usage can tell a changed
 * REQUEST (our fault) from a provider miss (eviction/routing).
 *
 * THE SEAM is the adapter's final prepared body — for ChatGPT the payload
 * after chatGPTPayload, i.e. exactly the JSON that is POSTed. Pi's
 * transcript is NOT equivalent for prefix purposes: the provider conversion
 * folds or drops system messages (resolveTranscript), rewrites foreign
 * reasoning (chatGPTHistory/transformMessages) and namespaces tools, so a
 * transcript prefix can hold while the wire prefix breaks, and vice versa.
 * Other engines (API-key, Claude Code CLI, other subscriptions) do not call
 * in, and their steps keep recording usage without the fields.
 *
 * Observation only: nothing here changes the body, and nothing throws into
 * the request path. Cost is one JSON pass and one sha256 over the input per
 * call. State is one small entry per chat (model, promptHash, item count and
 * a history digest — never bodies), LRU-bounded.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { RequestFingerprint } from "../core/contracts.ts";

interface PreviousRequest {
	model: string;
	promptHash: string;
	/** History items (input after the leading instruction items). */
	items: number;
	/** sha256 over those items, each serialized and newline-terminated. */
	digest: string;
}
interface FingerprintSink {
	chatId: string;
	deliver: (fingerprint: RequestFingerprint) => void;
}

const MAX_TRACKED_CHATS = 256;
// Next dev can instantiate this module once per route bundle; keep one
// tracker and one async context process-wide (the background-capture pattern).
const fingerprintGlobal = globalThis as typeof globalThis & {
	__lhRequestFingerprint?: { previous: Map<string, PreviousRequest>; sink: AsyncLocalStorage<FingerprintSink> };
};
const state = fingerprintGlobal.__lhRequestFingerprint ??= { previous: new Map(), sink: new AsyncLocalStorage() };

/** Run one model call (`dispatch` — the engine's stream function) with a
 * fingerprint sink for `chatId`: an adapter that observes its final body
 * reports it through notePreparedResponsesPayload, which hands the
 * fingerprint to `deliver`. Engines that never report leave it uncalled. */
export function withRequestFingerprint<T>(chatId: string, deliver: (fingerprint: RequestFingerprint) => void, dispatch: () => T): T {
	return state.sink.run({ chatId, deliver }, dispatch);
}

/** Prompt material at the head of `input`: the system prompt as developer/system items and, on
 *  models that declare tools in the input (gpt-5.5+), the opening `additional_tools` item.
 *  Later tool updates (e.g. the shared-handoff update) sit after history and stay history. */
const isPromptItem = (item: unknown): boolean => {
	const { role, type } = (item as { role?: unknown; type?: unknown } | null) ?? {};
	return role === "developer" || role === "system" || type === "additional_tools";
};

/** Fingerprint a final OpenAI Responses-shaped body (`instructions`,
 * `tools`, `input`) against the chat's previous one, and remember it.
 * Exported for tests; production calls arrive via notePreparedResponsesPayload. */
export function fingerprintResponsesPayload(chatId: string, payload: Record<string, unknown>): RequestFingerprint | undefined {
	const input = payload.input;
	if (!Array.isArray(input)) return undefined;
	// The system prompt (and, on gpt-5.5+, the tool declarations) ride input as
	// its leading items; they belong to the prompt, not the history.
	let lead = 0;
	while (lead < input.length && isPromptItem(input[lead])) lead++;
	const promptHash = createHash("sha256")
		.update(JSON.stringify([payload.instructions ?? null, payload.tools ?? null, input.slice(0, lead)]))
		.digest("hex")
		.slice(0, 12);
	const model = typeof payload.model === "string" ? payload.model : "";
	const previous = state.previous.get(chatId);
	const history = createHash("sha256");
	const items = input.length - lead;
	let prefixDigest: string | undefined;
	for (let i = 0; i < items; i++) {
		if (previous && i === previous.items) prefixDigest = history.copy().digest("hex");
		history.update(JSON.stringify(input[lead + i]) ?? "null").update("\n");
	}
	const digest = history.digest("hex");
	if (previous && items === previous.items) prefixDigest = digest;
	// One entry per chat, most recently used last; the oldest chat goes first.
	state.previous.delete(chatId);
	state.previous.set(chatId, { model, promptHash, items, digest });
	if (state.previous.size > MAX_TRACKED_CHATS) state.previous.delete(state.previous.keys().next().value!);
	if (!previous) return { promptHash };
	return {
		promptHash,
		extendsPrevious: previous.model === model && previous.promptHash === promptHash && prefixDigest === previous.digest,
	};
}

/** Called by an adapter with the body it is about to send. A no-op outside
 * withRequestFingerprint (compaction, extraction, background workers) and
 * never throws: diagnostics must not fail a request. */
export function notePreparedResponsesPayload(payload: Record<string, unknown>): void {
	const sink = state.sink.getStore();
	if (!sink) return;
	try {
		const fingerprint = fingerprintResponsesPayload(sink.chatId, payload);
		if (fingerprint) sink.deliver(fingerprint);
	} catch {
		// Diagnostics only — the step records usage without the fields.
	}
}

/** Test seam: forget every chat's previous request. */
export function resetRequestFingerprints(): void {
	state.previous.clear();
}
