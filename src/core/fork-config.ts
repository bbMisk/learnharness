/**
 * Fork switches the renderer and the server both read (Hanson's fork).
 * electron/fork-config.cjs holds the desktop shell's. Upstream files read
 * these through one-line hooks, so a fork decision lives here instead of as
 * an edit inside upstream code. Browser-safe: no node builtins.
 */

export type SideChatMode = "tutor" | "questions";

/** Which side conversation the app offers. "tutor": the fork's temporary
 *  side tutor (⌘⇧S) — upstream's side questions stay in the code, but every
 *  entry point to them is off. "questions": upstream's side questions, and
 *  the side tutor's entry points are off. */
const SIDE_CHAT: SideChatMode = "tutor";

/** Test-only override, read once at module load: LH_FORK_SIDE_CHAT=questions
 *  under NODE_ENV=test. A test sets it before its first app import. */
function testOverride(): SideChatMode | undefined {
	const env = typeof process === "undefined" ? undefined : process.env;
	return env?.NODE_ENV === "test" && env.LH_FORK_SIDE_CHAT === "questions" ? "questions" : undefined;
}

export const forkSideChat: SideChatMode = testOverride() ?? SIDE_CHAT;
export const sideQuestionsEnabled = forkSideChat === "questions";
export const sideTutorEnabled = forkSideChat === "tutor";
