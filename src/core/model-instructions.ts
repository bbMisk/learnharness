/**
 * MODEL INSTRUCTIONS (owner, 2026-11-06): optional learner-written guidance
 * for one exact model (provider + id), appended to every tutor agent's
 * system prompt (prober, teacher, practice, side tutor) while that model
 * teaches. Off by default: a model with no saved text changes nothing. The
 * suggestions are offered in Settings, never applied on their own.
 */

/** Per-model text cap (matches the flashcard curator guidance). */
export const MODEL_INSTRUCTIONS_MAX = 8000;

export function modelInstructionsKey(model: { provider: string; id: string }): string {
	return `${model.provider}:${model.id}`;
}

/** The system-prompt section for this model, or "" when none is saved. */
export function modelInstructionsFor(
	map: Readonly<Record<string, string>> | undefined,
	model: { provider: string; id: string } | null | undefined,
): string {
	const text = model ? map?.[modelInstructionsKey(model)]?.trim() : undefined;
	return text ? `User instructions for this model:\n${text}` : "";
}

const SUGGESTIONS: ReadonlyArray<{ match: RegExp; text: string }> = [
	{
		match: /opus/i,
		text:
			"Slow down. Teach one idea per message, then stop at a check before moving on. Lead with intuition: a concrete example or " +
			"picture first, then the formal statement. Keep messages short: cut asides, repeated summaries and extra headings. If a " +
			"sentence doesn't help the learner take the next step, leave it out.",
	},
	{
		match: /terra/i,
		text:
			"Don't over-split. Group closely related small steps into one message, and ask a check only when it tests something the " +
			"learner could plausibly get wrong; skip checks on a fact you just stated. Once the learner shows they've got a step, take " +
			"bigger steps.",
	},
];

/** Suggested starting text for a model, offered (not applied) in Settings. */
export function suggestedModelInstructions(modelId: string): string | undefined {
	return SUGGESTIONS.find((s) => s.match.test(modelId))?.text;
}
