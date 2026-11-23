/**
 * Hanson's fork: the Antigravity provider's server surface
 * (docs/antigravity.md): GET /api/antigravity status, PUT the opt-in,
 * POST "check connection", and the lesson-turn gate chat-handler calls.
 * While the server switch is off, GET answers 200 `{ available: false }` and
 * nothing else (a 404 would be a console error in every Settings window);
 * PUT and POST answer 404.
 */
import { AntigravityMessage } from "../agent/antigravity/constants.ts";
import { checkAntigravityAgent, type ConnectionCheck } from "../agent/antigravity/provider.ts";
import { describeAgentError } from "../agent/antigravity/runtime.ts";
import { ANTIGRAVITY_PROVIDER, ANTIGRAVITY_UNAVAILABLE, type AntigravityStatus } from "../core/contracts/antigravity.ts";
import { antigravitySwitchOn } from "../core/fork-config.ts";
import type { TurnInput } from "../core/input-events.ts";
import { reconstructRequestCause, type LhMessage } from "../core/native-messages.ts";
import { PROVIDER_KEY_MISSING_CODE } from "../core/settings.ts";
import { antigravityStore } from "../store/antigravity.ts";
import { antigravityAvailable, antigravityEnabled, antigravityInstalled } from "./antigravity-config.ts";
import { initAuthEnv } from "./keys.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
export const ANTIGRAVITY_INTENT_HEADER = "x-learnharness-antigravity";
const BACKGROUND_REFUSAL = "Antigravity runs only lessons you start. Automatic follow-ups stay queued.";

// The last failed check's message, per server process (not persisted).
const PROBLEM_KEY = Symbol.for("lh.antigravity.problem");
type ProblemGlobal = Record<symbol, { message?: string } | undefined>;
function problemState(): { message?: string } {
	const g = globalThis as ProblemGlobal;
	g[PROBLEM_KEY] ??= {};
	return g[PROBLEM_KEY];
}

export function antigravityStatus(): AntigravityStatus {
	const record = antigravityStore.read();
	const problem = problemState().message;
	return {
		available: true,
		enabled: antigravityEnabled(),
		installed: antigravityInstalled(),
		...(record.agentVersion ? { agentVersion: record.agentVersion } : {}),
		models: record.models.length,
		...(record.checkedAt ? { checkedAt: record.checkedAt } : {}),
		...(problem ? { problem } : {}),
	};
}

/** The explicit "Check connection": the only place besides a lesson turn that starts the agent. */
export async function checkAntigravityConnection(probe: () => Promise<ConnectionCheck> = () => checkAntigravityAgent()): Promise<AntigravityStatus> {
	if (!antigravityAvailable()) {
		problemState().message = antigravityEnabled() ? AntigravityMessage.NotInstalled : undefined;
		return antigravityStatus();
	}
	initAuthEnv(); // provenance first, so the agent's env never carries file-only keys
	try {
		const result = await probe();
		antigravityStore.update({ models: result.models, ...(result.agentVersion ? { agentVersion: result.agentVersion } : {}), checkedAt: new Date().toISOString() });
		problemState().message = undefined;
	} catch (error) {
		problemState().message = describeAgentError(error);
		// After a restart Settings must not still say "Connected": forget the check, keep the
		// model list so lessons pinned to one of its models still resolve.
		antigravityStore.update({ checkedAt: undefined });
	}
	return antigravityStatus();
}

export interface AntigravityRouteDeps {
	check: () => Promise<AntigravityStatus>;
	status: () => AntigravityStatus;
	setEnabled: (enabled: boolean) => void;
}

const production: AntigravityRouteDeps = {
	check: () => checkAntigravityConnection(),
	status: antigravityStatus,
	setEnabled: (enabled) => {
		antigravityStore.update({ enabled });
		problemState().message = undefined;
	},
};

async function jsonBody(request: Request): Promise<unknown> {
	const text = await request.text();
	if (text.length > 1_000) return undefined;
	try { return JSON.parse(text); } catch { return undefined; }
}

/** Same request protections as /api/claude-code: same-origin intent plus a custom header. No CORS grants. */
export async function antigravityResponse(request: Request, deps: AntigravityRouteDeps = production): Promise<Response> {
	if (!antigravitySwitchOn()) {
		return request.method === "GET"
			? Response.json({ available: false }, { headers: HEADERS })
			: Response.json({ error: "Not found" }, { status: 404, headers: HEADERS });
	}
	const origin = subscriptionRequestOrigin(request);
	const supplied = request.headers.get("origin");
	if (!origin || request.headers.get(ANTIGRAVITY_INTENT_HEADER) !== "1"
		|| request.headers.get("sec-fetch-site") === "cross-site"
		|| (supplied !== null && supplied !== origin)) {
		return Response.json({ error: "Antigravity settings require a same-origin LearnHarness request." }, { status: 403, headers: HEADERS });
	}
	switch (request.method) {
		case "GET":
			return Response.json(deps.status(), { headers: HEADERS });
		case "PUT": {
			const body = await jsonBody(request);
			const keys = typeof body === "object" && body !== null && !Array.isArray(body) ? Object.keys(body) : [];
			const enabled = (body as { enabled?: unknown } | undefined)?.enabled;
			if (keys.length !== 1 || typeof enabled !== "boolean") return Response.json({ error: "Send { enabled: true | false }." }, { status: 400, headers: HEADERS });
			deps.setEnabled(enabled);
			return Response.json(deps.status(), { headers: HEADERS });
		}
		case "POST": {
			const body = await jsonBody(request);
			if (typeof body !== "object" || body === null || (body as { action?: unknown }).action !== "check" || Object.keys(body).length !== 1) {
				return Response.json({ error: 'Send { action: "check" }.' }, { status: 400, headers: HEADERS });
			}
			if (!deps.status().enabled) return Response.json({ error: "Turn Antigravity on first." }, { status: 403, headers: HEADERS });
			return Response.json(await deps.check(), { headers: HEADERS });
		}
		default:
			return Response.json({ error: "Method not allowed" }, { status: 405, headers: HEADERS });
	}
}

/**
 * The lesson-turn door (chat-handler's one hook). Antigravity is admitted only
 * for a turn the learner started, and only while available. Wake-pipeline
 * steers and background continues are refused with 403, which the pump
 * treats as "keep the cargo queued". Every other door refuses Antigravity
 * through providerKeyPresent (src/server/keys.ts).
 */
export { ANTIGRAVITY_PROVIDER };

/** Every input type handleChatInput accepts, and whether the learner sends it. A new
 *  upstream type fails typecheck here until someone decides; unknown ones are refused. */
const LEARNER_INPUT: Record<TurnInput["type"], boolean> = {
	text: true,
	answer: true,
	retry: true,
	"retry-question": true,
	thinking: true,
	next: true,
	"plugin-question-answer": true,
	"plugin-problem-submission": true,
	continue: false, // admitted only when it resumes a reply the learner is owed (foreground cause)
	steers: false, // the wake pipeline
};

export function antigravityTurnRefusal(inputType: string, messages: readonly LhMessage[]): Response | null {
	const learner = Object.hasOwn(LEARNER_INPUT, inputType) && LEARNER_INPUT[inputType as TurnInput["type"]];
	if (!learner && !(inputType === "continue" && reconstructRequestCause(messages) === "foreground")) {
		return Response.json({ error: BACKGROUND_REFUSAL }, { status: 403 });
	}
	if (!antigravityAvailable()) {
		return Response.json({ error: ANTIGRAVITY_UNAVAILABLE, code: PROVIDER_KEY_MISSING_CODE, provider: ANTIGRAVITY_PROVIDER, slots: ["strong"] }, { status: 503 });
	}
	initAuthEnv(); // provenance first, so the agent's env never carries file-only keys
	return null;
}
