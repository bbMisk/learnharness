/**
 * Fork switches the renderer and the server both read (Hanson's fork).
 * electron/fork-config.cjs holds the desktop shell's. Upstream files read
 * these through one-line hooks, so a fork decision lives here instead of as
 * an edit inside upstream code. Browser-safe: no node builtins.
 */

export { ANTIGRAVITY_PROVIDER, isAntigravityRefusal, type AntigravityStatus, type AntigravityStatusResponse } from "./contracts/antigravity.ts";

export type SideChatMode = "tutor" | "questions";

/** Which side conversation the app offers. "tutor": the fork's temporary
 *  side tutor (⌘⇧S) — upstream's side questions stay in the code, but every
 *  entry point to them is off. "questions": upstream's side questions, and
 *  the side tutor's entry points are off. */
const SIDE_CHAT: SideChatMode = "tutor";

/** Upstream's own tests of side-question delivery drive the feature itself,
 *  so their processes run in "questions" mode, unmodified. */
const UPSTREAM_SIDE_QUESTION_TESTS = /[\\/]tests[\\/](side-chat-delivery|side-chat-cli-budget|plugin-side-compaction|chatgpt-request-cycle)\.test\.tsx?$/;

/** Test-only override, read once at module load and only under
 *  NODE_ENV=test: LH_FORK_SIDE_CHAT=questions (a test sets it before its
 *  first app import), or one of upstream's side-question test files. */
function testOverride(): SideChatMode | undefined {
	const proc = typeof process === "undefined" ? undefined : process;
	if (proc?.env?.NODE_ENV !== "test") return undefined;
	return proc.env.LH_FORK_SIDE_CHAT === "questions" || UPSTREAM_SIDE_QUESTION_TESTS.test(proc.argv?.[1] ?? "") ? "questions" : undefined;
}

export const forkSideChat: SideChatMode = testOverride() ?? SIDE_CHAT;
export const sideQuestionsEnabled = forkSideChat === "questions";
export const sideTutorEnabled = forkSideChat === "tutor";

/** The newest chat record version this build reads: upstream's (2, which
 *  added side-question threads). Stage one of two: writes keep stamping
 *  CURRENT_CHAT_VERSION (1) until the next release adopts upstream's. */
export const READABLE_CHAT_VERSION = 2;

/** The Antigravity provider (docs/antigravity.md), off unless the SERVER's
 *  environment sets LH_FORK_ANTIGRAVITY=1. Read live, server side only: the
 *  renderer learns it from GET /api/antigravity, which answers 404 while off. */
const ANTIGRAVITY = false;
export function antigravitySwitchOn(): boolean {
	const proc = typeof process === "undefined" ? undefined : process;
	return ANTIGRAVITY || proc?.env?.LH_FORK_ANTIGRAVITY === "1";
}
