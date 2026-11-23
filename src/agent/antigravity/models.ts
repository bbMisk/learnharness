/**
 * Reading the agent's session config: the approval mode and the model list.
 * The model list comes ONLY from the agent's `configOptions` model select;
 * LearnHarness never invents model ids and reads no older shapes.
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

/** A model id or name LearnHarness will show and store: no link, no control character, at most 200 characters. */
export function safeModelText(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "" && value.length <= 200 && !value.includes("://") && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** Drops the entry whenever its id, or a name it does give, is unsafe. */
function entry(id: unknown, name: unknown): AgentModel[] {
	if (!safeModelText(id)) return [];
	if (name === undefined || name === null || name === "") return [{ id, name: id }];
	return safeModelText(name) ? [{ id, name }] : [];
}

function selectValues(options: unknown): AgentModel[] {
	if (!Array.isArray(options)) return [];
	return options.flatMap((option): AgentModel[] => {
		if (!isRecord(option)) return [];
		// Grouped selects hold their values one level down.
		if (Array.isArray(option.options)) return selectValues(option.options);
		return entry(option.value, option.name);
	});
}

/** The select whose id or category is `key` ("mode" or "model"). */
export function findConfigOption(configOptions: unknown, key: "mode" | "model"): ConfigSelect | null {
	if (!Array.isArray(configOptions)) return null;
	const option = configOptions.find((entry) => isRecord(entry) && (entry.id === key || entry.category === key));
	if (!isRecord(option) || typeof option.id !== "string") return null;
	return { configId: option.id, currentValue: typeof option.currentValue === "string" ? option.currentValue : undefined, values: selectValues(option.options) };
}

/** The models a session/new result (or a config_option_update) offers through its model config option,
 *  or null when it has none. Older shapes (`models.availableModels`) are not read. */
export function modelsFrom(result: unknown): AgentModel[] | null {
	if (!isRecord(result)) return null;
	const values = findConfigOption(result.configOptions, "model")?.values;
	if (!values) return null;
	const seen = new Set<string>();
	return values.filter((model) => !seen.has(model.id) && seen.add(model.id));
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
