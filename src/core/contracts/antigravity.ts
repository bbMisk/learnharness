/** Hanson's fork: the opt-in Antigravity provider (docs/antigravity.md). */
export const ANTIGRAVITY_PROVIDER = "antigravity";

/** What GET /api/antigravity reports while the server switch is on. Never a path, a sign-in link or raw agent output. */
export interface AntigravityStatus {
	/** The server switch is on. (While it is off, GET answers only `{ available: false }`.) */
	available: true;
	enabled: boolean;
	/** An `agy` file was found. Nothing was executed to learn this. */
	installed: boolean;
	/** From the last successful check, e.g. "1.5.12". */
	agentVersion?: string;
	/** How many models the last successful check listed. */
	models: number;
	/** ISO time of the last successful check. */
	checkedAt?: string;
	/** A plain message from the last failed check, e.g. not signed in. */
	problem?: string;
	/** The user pressed Sign in and the agent's browser sign-in is still running. */
	signingIn?: true;
}

/** GET /api/antigravity: 200 either way, so a switched-off server causes no browser console error. */
export type AntigravityStatusResponse = AntigravityStatus | { available: false };

/** With LH_ANTIGRAVITY_HELPERS=0, every helper (jobs, extraction, side tutor, plugins, …) refuses Antigravity. */
export const ANTIGRAVITY_LESSONS_ONLY = "Antigravity runs only lessons you start. Choose another model for this in Settings → Models.";
/** No sign-in (or the agent could not open a browser for one). The settings row then offers Sign in first. */
export const ANTIGRAVITY_NOT_SIGNED_IN = 'Not signed in to Antigravity. Run "agy" in a terminal and sign in, then check again in Settings.';
/** A lesson turn (or, with helpers on, any call) while the provider is off, not opted in, or not installed. */
export const ANTIGRAVITY_UNAVAILABLE = "Antigravity is unavailable. Turn it on and check the connection in Settings → Providers.";

/** The refusals above read as setup guidance, like a missing key. */
export function isAntigravityRefusal(error: string | undefined): boolean {
	return error === ANTIGRAVITY_LESSONS_ONLY || error === ANTIGRAVITY_UNAVAILABLE;
}

/**
 * The one sanitizer for what the agent reports, shared by the agent layer
 * (agent/antigravity/models.ts) and the store (store/antigravity.ts).
 */

/** A model id or name LearnHarness will show and store: no link, no control character, at most 200 characters. */
export function safeModelText(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "" && value.length <= 200 && !value.includes("://") && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** A thinking level value LearnHarness keeps: lowercase letters, digits, `_` or `-`, at most 32 characters. */
const LEVEL_VALUE = /^[a-z0-9_-]{1,32}$/;

/** Only well-formed level values, deduplicated, in the agent's order, at most 16. */
export function sanitizeLevels(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	const seen = new Set<string>();
	return values.filter((value): value is string => typeof value === "string" && LEVEL_VALUE.test(value) && !seen.has(value) && !!seen.add(value)).slice(0, 16);
}

/** An agent version as LearnHarness stores and shows it: "1.5.15". */
export function isAgentVersion(value: unknown): value is string {
	return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}
