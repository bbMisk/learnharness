/**
 * Fork switches the renderer and the server both read (Hanson's fork).
 * electron/fork-config.cjs holds the desktop shell's. Upstream files read
 * these through one-line hooks, so a fork decision lives here instead of as
 * an edit inside upstream code. Browser-safe: no node builtins.
 */

export { ANTIGRAVITY_PROVIDER, isAgentVersion, isAntigravityRefusal, type AntigravityStatus, type AntigravityStatusResponse } from "./contracts/antigravity.ts";

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

/** The Antigravity provider's server switch (docs/antigravity.md): on (owner
 *  go-ahead 2026-11-23). The SERVER's environment can force it:
 *  LH_FORK_ANTIGRAVITY=0 off, =1 on; anything else keeps this default. Each
 *  user still opts in separately (antigravity.json, off by default). Read live,
 *  server side only: the renderer learns it from GET /api/antigravity
 *  (`{ available: false }` while off). */
const ANTIGRAVITY = true;
export function antigravitySwitchOn(): boolean {
	const proc = typeof process === "undefined" ? undefined : process;
	const forced = proc?.env?.LH_FORK_ANTIGRAVITY;
	if (forced === "0") return false;
	if (forced === "1") return true;
	return ANTIGRAVITY;
}

/** Antigravity session reuse (docs/antigravity.md): a lesson continues its agent session while the
 *  conversation only grows. On; the SERVER's LH_ANTIGRAVITY_REUSE=0 turns it off (a fresh agent
 *  session per reply, the earlier behaviour). Read live. */
export function antigravityReuseOn(): boolean {
	const proc = typeof process === "undefined" ? undefined : process;
	return proc?.env?.LH_ANTIGRAVITY_REUSE !== "0";
}

/** LearnHarness tools on Antigravity lessons (docs/antigravity.md): the agent may call the lesson's
 *  declared tools through a loopback MCP bridge, and a lesson accepts the follow-ups its own tools
 *  cause. On; the SERVER's LH_ANTIGRAVITY_TOOLS=0 turns it off (text-only, the earlier behaviour).
 *  Read live. */
export function antigravityToolsOn(): boolean {
	const proc = typeof process === "undefined" ? undefined : process;
	return proc?.env?.LH_ANTIGRAVITY_TOOLS !== "0";
}
