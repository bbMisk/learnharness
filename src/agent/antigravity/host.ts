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
	/**
	 * Whether a pi session id is a lesson's (a saved chat's id): only those turns recur, so only
	 * their agent sessions are parked for reuse, and only they fall back to text-only without tools.
	 * Helper runs (random ids, record ids) never park and never run half-working. Asked once per turn;
	 * a lookup that throws counts as "helper". Absent: every keyed call counts as a lesson (the
	 * behaviour before helpers); the production host always supplies it.
	 */
	isLessonKey?(key: string): boolean;
	/** The server's LH_ANTIGRAVITY_HELPERS switch (absent: on). Checked again at the last door. */
	helpersOn?(): boolean;
}

const CLOSED: AntigravityHost = { available: () => false, models: () => [], saveModels: () => {}, isLessonKey: () => false };
const HOST_KEY = Symbol.for("lh.antigravity.host");
type HostGlobal = Record<symbol, AntigravityHost | undefined>;

export function configureAntigravityHost(host: AntigravityHost): void {
	(globalThis as HostGlobal)[HOST_KEY] = host;
}

export function antigravityHost(): AntigravityHost {
	return (globalThis as HostGlobal)[HOST_KEY] ?? CLOSED;
}
