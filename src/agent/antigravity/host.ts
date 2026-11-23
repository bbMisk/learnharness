/**
 * What the server tells the agent layer (the agent never imports the store):
 * whether a turn may start, the last known model list, and where newly seen
 * models go. Unconfigured, everything is closed: no models, no turns.
 */
import type { AgentModel } from "./models.ts";

export interface AntigravityHost {
	/** Server switch on, user opt-in on, binary file present. */
	available(): boolean;
	/** The persisted model list. */
	models(): readonly AgentModel[];
	/** A session listed these models. */
	saveModels(models: AgentModel[]): void;
}

const CLOSED: AntigravityHost = { available: () => false, models: () => [], saveModels: () => {} };
const HOST_KEY = Symbol.for("lh.antigravity.host");
type HostGlobal = Record<symbol, AntigravityHost | undefined>;

export function configureAntigravityHost(host: AntigravityHost): void {
	(globalThis as HostGlobal)[HOST_KEY] = host;
}

export function antigravityHost(): AntigravityHost {
	return (globalThis as HostGlobal)[HOST_KEY] ?? CLOSED;
}
