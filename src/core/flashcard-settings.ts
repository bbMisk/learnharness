import type { FlashcardAgentSettings } from "./settings.ts";

/** Keep only well-typed flashcard-agent fields; the daily limit is clamped to 1-100. */
export function sanitizeFlashcardSettings(raw: unknown): FlashcardAgentSettings | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	const out: FlashcardAgentSettings = {};
	if (typeof value.enabled === "boolean") out.enabled = value.enabled;
	if (typeof value.dailyLimit === "number" && Number.isFinite(value.dailyLimit))
		out.dailyLimit = Math.max(1, Math.min(100, Math.round(value.dailyLimit)));
	if (typeof value.instructions === "string") out.instructions = value.instructions.slice(0, 8000);
	return out;
}
