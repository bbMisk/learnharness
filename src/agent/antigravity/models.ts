/**
 * Reading the agent's session config: the approval mode and the model list.
 * The model list comes ONLY from the agent (a `configOptions` select, or the
 * legacy `models` field); LearnHarness never invents model ids.
 */
import type { Api, Model } from "@earendil-works/pi-ai";

import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER } from "./constants.ts";

export interface AgentModel {
	id: string;
	name: string;
}

export interface ConfigSelect {
	configId: string;
	currentValue: string | undefined;
	values: AgentModel[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectValues(options: unknown): AgentModel[] {
	if (!Array.isArray(options)) return [];
	return options.flatMap((option): AgentModel[] => {
		if (!isRecord(option)) return [];
		// Grouped selects hold their values one level down.
		if (Array.isArray(option.options)) return selectValues(option.options);
		if (typeof option.value !== "string" || !option.value) return [];
		return [{ id: option.value, name: typeof option.name === "string" && option.name ? option.name : option.value }];
	});
}

/** The select whose id or category is `key` ("mode" or "model"). */
export function findConfigOption(configOptions: unknown, key: "mode" | "model"): ConfigSelect | null {
	if (!Array.isArray(configOptions)) return null;
	const option = configOptions.find((entry) => isRecord(entry) && (entry.id === key || entry.category === key));
	if (!isRecord(option) || typeof option.id !== "string") return null;
	return { configId: option.id, currentValue: typeof option.currentValue === "string" ? option.currentValue : undefined, values: selectValues(option.options) };
}

/** Legacy `models: { currentModelId, availableModels: [{ modelId, name }] }`. */
export function legacyModels(result: unknown): { currentModelId: string | undefined; values: AgentModel[] } | null {
	if (!isRecord(result) || !isRecord(result.models) || !Array.isArray(result.models.availableModels)) return null;
	const values = result.models.availableModels.flatMap((entry): AgentModel[] =>
		isRecord(entry) && typeof entry.modelId === "string" && entry.modelId
			? [{ id: entry.modelId, name: typeof entry.name === "string" && entry.name ? entry.name : entry.modelId }]
			: []);
	return { currentModelId: typeof result.models.currentModelId === "string" ? result.models.currentModelId : undefined, values };
}

/** The models a session/new result (or a config_option_update) offers, or null when it says nothing. */
export function modelsFrom(result: unknown): AgentModel[] | null {
	if (!isRecord(result)) return null;
	const option = findConfigOption(result.configOptions, "model");
	const values = option?.values ?? legacyModels(result)?.values;
	if (!values) return null;
	const seen = new Set<string>();
	return values.filter((model) => !seen.has(model.id) && seen.add(model.id));
}

/** Legacy `modes: { currentModeId, availableModes: [{ id }] }`. */
export function legacyModes(result: unknown): { currentModeId: string | undefined; ids: string[] } | null {
	if (!isRecord(result) || !isRecord(result.modes) || !Array.isArray(result.modes.availableModes)) return null;
	const ids = result.modes.availableModes.flatMap((mode) => (isRecord(mode) && typeof mode.id === "string" ? [mode.id] : []));
	return { currentModeId: typeof result.modes.currentModeId === "string" ? result.modes.currentModeId : undefined, ids };
}

const SHARED_MODEL_FIELDS = {
	api: ANTIGRAVITY_API,
	provider: ANTIGRAVITY_PROVIDER,
	baseUrl: "",
	input: ["text"],
	// Pi-required placeholders, not prices or limits: the catalog DTO nulls
	// them and pricing reports Antigravity as unpriced.
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 1_000_000,
	maxTokens: 64_000,
} satisfies Omit<Model<Api>, "id" | "name">;

export function toPiModel(model: AgentModel): Model<Api> {
	return { ...SHARED_MODEL_FIELDS, input: ["text"], id: model.id, name: model.name };
}
