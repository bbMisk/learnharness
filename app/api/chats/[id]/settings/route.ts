import {
	clampChatLevel,
	effectiveSettings,
	getChat,
	parseSettingsBody,
	stores,
	validateChatSettings,
} from "@/src/server";
import { sanitizeQuestionType, type ChatSettings } from "@/src/core";

/**
 * The per-chat model control (model-control wave): replace-whole settings —
 * the picker sends the complete desired object ({} clears all overrides).
 * PER-SESSION MODELS (owner, 2026-09-28): this route is THE in-session
 * writer — the composer's control binds the session's own record; the
 * strong slot is only the birth default and never reaches an existing
 * session again.
 * Validation is the catalog gate (src/server/model-catalog.ts): unknown
 * provider/model is a 400. Thinking levels never reject (owner,
 * interlude 2026-09-22): a pinned level clamps to the named model's
 * nearest supported and the clamped value is stored. Effective next turn
 * by construction (agents are stateless per turn).
 *
 * One exception to replace-whole: `questionType` (the lesson's question
 * type, owner 2026-11-03) is kept when a body omits it — see PUT.
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
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });

	const body = await req.json().catch(() => null);
	const parsed = parseSettingsBody(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

	// The catalog gate checks a model the write introduces, never the saved
	// one re-sent unchanged (validateModelsSettings' discipline): the Qs
	// chip re-sends the session's model, which must not block its save while
	// that model's provider is disconnected.
	const saved = chat.settings?.model;
	const unchanged = parsed.settings.model !== undefined && saved !== undefined &&
		parsed.settings.model.provider === saved.provider && parsed.settings.model.id === saved.id;
	const verdict = unchanged ? ({ ok: true } as const) : validateChatSettings(parsed.settings);
	if (!verdict.ok) {
		return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
	}

	// Replace-whole persists the validated, level-clamped object — no
	// merges, so a stale client can never resurrect a cleared override.
	// Clamp-on-write (owner, interlude 2026-09-22): a pinned thinking
	// level never rejects — it clamps to the named model's nearest
	// supported (body model, else the record's strong slot).
	const clamped = clampChatLevel(parsed.settings, effectiveSettings().models.strong);
	// The lesson's question type (owner, 2026-11-03) is not a model control:
	// the model picker's writes never name it, so a body without it keeps the
	// stored choice. The header's Qs chip sends it with the model fields it
	// just read (replace-whole for those, as ever).
	const kept = sanitizeQuestionType(chat.settings?.questionType);
	const settings: ChatSettings = clamped.questionType === undefined && kept ? { ...clamped, questionType: kept } : clamped;
	stores.chatStore.saveSettings(id, settings);
	return Response.json({ settings });
}
