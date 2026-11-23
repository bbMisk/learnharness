/**
 * Reading the agent's session config: the approval mode, the model list and
 * each model's thinking levels. Both lists come ONLY from the agent's
 * `configOptions` selects; LearnHarness never invents ids or levels and reads
 * no older shapes.
 */
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";

import { safeModelText, sanitizeLevels } from "../../core/contracts/antigravity.ts";
import { isRecord } from "./acp-client.ts";
import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER } from "./constants.ts";
import { antigravityToolsOn } from "../../core/fork-config.ts";

export { safeModelText, sanitizeLevels };

export interface AgentModel {
	id: string;
	name: string;
	/** The thinking levels the agent offers for this model, exactly as it names them. Unknown: undefined. */
	levels?: string[];
	/** The level the agent selects for this model when none is set. */
	defaultLevel?: string;
}

export interface ConfigSelect {
	configId: string;
	currentValue: string | undefined;
	values: AgentModel[];
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

/** The select whose id or category is `key` ("mode", "model" or "thought_level"). */
export function findConfigOption(configOptions: unknown, key: "mode" | "model" | "thought_level"): ConfigSelect | null {
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

/** The thinking levels offered by these options (for the model they currently select), and the selected one. */
export function levelsFrom(configOptions: unknown): { levels: string[]; defaultLevel?: string } {
	const option = findConfigOption(configOptions, "thought_level");
	if (!option) return { levels: [] };
	const levels = sanitizeLevels(option.values.map((value) => value.id));
	const current = option.currentValue;
	return { levels, ...(current && levels.includes(current) ? { defaultLevel: current } : {}) };
}

/** LearnHarness's levels, each sent to the agent under the same name when it offers that name. No "off". */
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly (ThinkingLevel | "off")[];

export function thinkingLevelMap(levels: readonly string[]): Record<(typeof PI_LEVELS)[number], string | null> {
	return Object.fromEntries(PI_LEVELS.map((level) => [level, level !== "off" && levels.includes(level) ? level : null])) as Record<(typeof PI_LEVELS)[number], string | null>;
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

/** A model with at least one level LearnHarness can name reasons, floored at its lowest level (like Claude Code). */
export function toPiModel(model: AgentModel): Model<Api> {
	// Images reach the model with the tools switch on (learner images as prompt blocks, tool images as MCP results).
	const base = { ...SHARED_MODEL_FIELDS, input: (antigravityToolsOn() ? ["text", "image"] : ["text"]) as Model<Api>["input"], id: model.id, name: model.name };
	const map = thinkingLevelMap(model.levels ?? []);
	if (!Object.values(map).some((value) => value !== null)) return base;
	return { ...base, reasoning: true, thinkingLevelMap: map };
}
