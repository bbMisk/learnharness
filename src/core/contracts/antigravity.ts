/** Hanson's fork: the opt-in Antigravity provider (docs/antigravity.md). */
export const ANTIGRAVITY_PROVIDER = "antigravity";

/** What GET /api/antigravity reports. Never a path, a sign-in link or raw agent output. */
export interface AntigravityStatus {
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
}
