import {
	clampChatLevel,
	effectiveSettings,
	getChat,
	mergeChatSettings,
	namesModelPair,
	parseSettingsBody,
	stores,
	validateChatSettings,
} from "@/src/server";
import { emit, type ChatSettings } from "@/src/core";

/**
 * The per-chat model control (model-control wave) and the lesson's question
 * type (owner, 2026-11-03). FIELD-LEVEL writes (fix, 2026-11-03): a body
 * names the fields it changes and the write merges them into the CURRENT
 * record (mergeChatSettings) — the model pair {model, thinkingLevel} is one
 * field group (naming either replaces both, so the picker's {model} still
 * clears a stale level), `questionType` another. The model picker sends
 * only the model pair, the Qs chip only `questionType`, so neither can
 * restore the other's older value; a full object still replaces every group
 * it names. Unknown keys are dropped; `{}` changes nothing.
 * PER-SESSION MODELS (owner, 2026-09-28): this route is THE in-session
 * writer — the composer's control binds the session's own record; the
 * strong slot is only the birth default and never reaches an existing
 * session again.
 * Validation is the catalog gate (src/server/model-catalog.ts): a model the
 * write CHANGES must be in the catalog (unknown provider/model is a 400);
 * the saved model re-sent unchanged is never re-checked
 * (validateModelsSettings' discipline). Thinking levels never reject (owner,
 * interlude 2026-09-22): a pinned level clamps to the named model's
 * nearest supported and the clamped value is stored. Effective next turn
 * by construction (agents are stateless per turn).
 *
 * The body parsing itself is shared with the draft route
 * (src/server/settings-body.ts, default-settings wave 2026-09-18).
 */
/** Read the control's settings without transferring the lesson history. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const chat = getChat((await params).id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ settings: chat.settings }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });

	const body = await req.json().catch(() => null);
	const parsed = parseSettingsBody(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

	// THE WRITE BOUNDARY: everything below is synchronous — no await between
	// reading the current record and saving the merge, so a write that
	// landed while this body was still arriving is the base, never lost and
	// never compared against a stale snapshot.
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	const merged = mergeChatSettings(chat.settings, body, parsed.settings);
	// The model pair is checked and clamped only when this write names it:
	// a question-type write leaves a stored pin exactly as it was.
	let settings = merged;
	if (namesModelPair(body)) {
		if (!sameModel(merged.model, chat.settings?.model)) {
			const verdict = validateChatSettings(merged);
			if (!verdict.ok) {
				return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
			}
		}
		// Clamp-on-write (owner, interlude 2026-09-22): a pinned thinking
		// level never rejects — it clamps to the named model's nearest
		// supported (the merged model, else the record's strong slot).
		settings = clampChatLevel(merged, effectiveSettings().models.strong);
	}
	stores.chatStore.saveSettings(id, settings);
	// Open views of this chat (other tabs, other devices) refetch the record.
	emit("record-changed", { chatId: id });
	return Response.json({ settings });
}

function sameModel(a: ChatSettings["model"], b: ChatSettings["model"]): boolean {
	return a?.provider === b?.provider && a?.id === b?.id;
}
