import type { Model } from "@earendil-works/pi-ai";

const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Account discovery owns availability and current capabilities. Pi's exact-ID
 * entry is only a fallback for older, sparse discovery responses, never an
 * allowlist. Unknown output limits use 0 internally (unknown), not a sibling's
 * guessed limit; subscription transport never sends max_output_tokens.
 * Ultra is orchestration, outside this harness's supported thinking levels. */
export function projectChatGPTModels(entries: unknown[], known: readonly Model<"openai-responses">[]) {
	const models: Model<"openai-responses">[] = [];
	const fastTiers: Record<string, "priority" | "fast"> = {};
	for (const entry of entries) {
		if (
			!record(entry) ||
			entry.visibility !== "list" ||
			entry.supported_in_api === false ||
			typeof entry.slug !== "string" ||
			!entry.slug ||
			models.some((m) => m.id === entry.slug)
		)
			continue;
		const template = known.find((m) => m.id === entry.slug);
		const contextWindow = positive(entry.context_window) ? entry.context_window : template?.contextWindow;
		const input = Array.isArray(entry.input_modalities)
			? entry.input_modalities.filter((v): v is "text" | "image" => v === "text" || v === "image")
			: template?.input;
		const advertised = Array.isArray(entry.supported_reasoning_levels)
			? entry.supported_reasoning_levels.flatMap((v) => (record(v) && typeof v.effort === "string" ? [v.effort] : []))
			: undefined;
		const thinkingLevelMap = advertised
			? Object.fromEntries(
					levels.map((level) => [
						level,
						advertised.includes(level === "off" ? "none" : level) ? (level === "off" ? "none" : level) : null,
					]),
				)
			: template?.thinkingLevelMap;
		// A new ID needs real capability metadata. Fail closed on incomplete
		// entries rather than copying an unrelated model's capabilities.
		if (
			!contextWindow ||
			!input?.includes("text") ||
			(!template && (!advertised || (advertised.length > 0 && !levels.some((level) => thinkingLevelMap?.[level] != null))))
		)
			continue;
		const reasoning = advertised ? advertised.some((level) => level !== "none") : (template?.reasoning ?? false);
		models.push({
			...template,
			id: entry.slug,
			name: typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name : (template?.name ?? entry.slug),
			api: "openai-responses",
			provider: "chatgpt",
			baseUrl: "https://api.openai.com/v1",
			reasoning,
			input: [...input],
			contextWindow,
			maxTokens: positive(entry.max_output_tokens) ? entry.max_output_tokens : (template?.maxTokens ?? 0),
			thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const tiers = Array.isArray(entry.service_tiers) ? entry.service_tiers : [];
		const tier = tiers.find((t) => record(t) && t.id === "priority") ?? tiers.find((t) => record(t) && t.id === "fast");
		if (record(tier) && (tier.id === "priority" || tier.id === "fast")) fastTiers[entry.slug] = tier.id;
	}
	return { models, fastTiers };
}
