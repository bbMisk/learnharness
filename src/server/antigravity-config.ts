/**
 * Hanson's fork: whether the Antigravity provider may run (docs/antigravity.md).
 * File checks only: nothing on this path executes the agent. Importing this
 * module hands the agent layer its view (availability + the model list).
 */
import { getAgyBinary } from "../agent/antigravity/binary.ts";
import { configureAntigravityHost } from "../agent/antigravity/host.ts";
import { ANTIGRAVITY_PROVIDER } from "../core/contracts/antigravity.ts";
import type { CatalogProvider } from "../core/contracts/models.ts";
import { antigravitySwitchOn } from "../core/fork-config.ts";
import { antigravityStore } from "../store/antigravity.ts";

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

/** The catalog's provider row: present only while the server switch is on. */
export function antigravityCatalogRows(): CatalogProvider[] {
	return antigravitySwitchOn() ? [{ id: ANTIGRAVITY_PROVIDER, envVar: "", keyPresent: antigravityAvailable() }] : [];
}

configureAntigravityHost({
	available: antigravityAvailable,
	models: () => (antigravityAvailable() ? antigravityStore.read().models : []),
	saveModels: (models) => { antigravityStore.update({ models }); },
});
