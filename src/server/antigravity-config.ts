/**
 * Hanson's fork: whether the Antigravity provider may run (docs/antigravity.md).
 * File checks only: nothing on this path executes the agent. Importing this
 * module hands the agent layer its view (availability + the model list).
 */
import { getAgyBinary } from "../agent/antigravity/binary.ts";
import { configureAntigravityHost } from "../agent/antigravity/host.ts";
import { ANTIGRAVITY_PROVIDER } from "../core/contracts/antigravity.ts";
import type { CatalogProvider } from "../core/contracts/models.ts";
import { antigravitySwitchOn, antigravityToolsOn } from "../core/fork-config.ts";
import { antigravityStore, type AntigravityModelEntry } from "../store/antigravity.ts";
import type { AgentModel } from "../agent/antigravity/models.ts";

export { ANTIGRAVITY_PROVIDER };

/** Server switch and the user's opt-in. */
export function antigravityEnabled(): boolean {
	return antigravitySwitchOn() && antigravityStore.read().enabled;
}

/** An `agy` file exists (LH_AGY_BINARY or the usual folders). */
export function antigravityInstalled(): boolean {
	return getAgyBinary() !== null;
}

/** Switch on, opted in, binary file present. Never authentication readiness. */
export function antigravityAvailable(): boolean {
	return antigravityEnabled() && antigravityInstalled();
}

/**
 * Automatic follow-ups in an Antigravity lesson (any wake-pipeline steer for the chat: job results,
 * the prober→teacher handoff; and the background continue after them), admitted only with the tools
 * switch on, while available. Not narrowed to what the lesson's own tools caused (lead's decision).
 * The jobs themselves still never run on an Antigravity model (providerKeyPresent stays false).
 */
export function antigravityFollowUpsAllowed(): boolean {
	return antigravityToolsOn() && antigravityAvailable();
}

/** The catalog's provider row: present only while the server switch is on. */
export function antigravityCatalogRows(): CatalogProvider[] {
	return antigravitySwitchOn() ? [{ id: ANTIGRAVITY_PROVIDER, envVar: "", keyPresent: antigravityAvailable() }] : [];
}

configureAntigravityHost({
	available: antigravityAvailable,
	models: () => {
		if (!antigravitySwitchOn()) return [];
		const record = antigravityStore.read(); // one read: availability and the list from the same record
		return record.enabled && antigravityInstalled() ? record.models : [];
	},
	saveModels: (models) => { antigravityStore.update((current) => ({ models: mergeModels(current.models, models) })); },
});

/** A new list keeps each model's known levels unless the new entry states its own. */
export function mergeModels(previous: readonly AntigravityModelEntry[], next: readonly AgentModel[]): AntigravityModelEntry[] {
	const known = new Map(previous.map((model) => [model.id, model]));
	return next.map((model) => {
		const old = known.get(model.id);
		if (model.levels) return { id: model.id, name: model.name, levels: model.levels, ...(model.defaultLevel ? { defaultLevel: model.defaultLevel } : {}) };
		return { id: model.id, name: model.name, levels: old?.levels ?? [], ...(old?.defaultLevel ? { defaultLevel: old.defaultLevel } : {}) };
	});
}
