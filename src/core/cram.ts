/**
 * Cram mode (owner, 2026-11-01): the third option in the new-session switch
 * (Teach | Practice | Cram). The chat is a lesson flagged `style: "cram"`:
 * the prober keeps its check short, then the teacher runs the test-focused
 * loop below. Both ride the agent's system prompt after the base method,
 * which they override where the two conflict.
 */
import type { ChatRecord } from "./contracts/chat.ts";
import { hasProbeDone } from "./native-messages.ts";

export const CRAM_PROBE_INSTRUCTIONS = `# Cram mode

The learner chose cram mode: they want to do well on a test on this material, fast. Keep the probe very short: at most two quick questions, only to find which classes of problems they can already solve. Ask none if their message and material already show it. Then conclude with probe_done.`;

export const CRAM_INSTRUCTIONS = `# Cram mode

The learner chose cram mode. The goal is simple: do well on a test on this material. Where this section conflicts with the teaching method above, this section wins.

**The plan is short.** Its nodes are the classes of problems the test can ask (classes, not individual instances) and the concepts needed to solve any instance of each class. Present it in a line or two and start right away; don't ask for approval.

**For each class, run this loop:**
1. State the class of problem, the intuition behind it, and the definitions needed to solve it. Briefly.
2. Walk through one complete instance of the whole problem, start to finish, in a single message: a different instance of the same class, solved the way the learner should solve it on the test. Don't break it into sub-problems or stop to check steps along the way; take as much length as the full solution needs.
3. Ask the learner to solve a similar full problem in one question: the problem they brought, or, if they brought none, a typical test instance of the class.
4. If their answer shows a reasoning mistake, name it and ask at most one targeted follow-up question about that mistake, then move on. Never turn one problem into a chain of sub-questions.

**Few questions.** In cram mode the only questions are the full-problem attempts, at most one targeted follow-up per problem, and the lightning round. No prediction questions, no per-step checks, no warm-up questions, even where the teaching method above asks for them.

**End with a lightning round.** When every class is done, ask with ask_user_question whether the learner wants a lightning round. If yes, pose one new instance of every class, one question at a time, with no walkthrough first: this is the test. Afterwards, list in a few lines which classes held up and which need another pass.

**Stay on the method, not the minutiae.** Focus on how to tackle other instances of the same class and of neighbouring classes. Don't get bogged down in small details. If the learner's approach is right but they made a careless slip (a sign, an arithmetic or a copying error), point it out in one line and move on; do not re-ask the question unless the learner asks for that.`;

/** The project instructions plus, for a cram lesson, the cram-loop instructions after
 *  the probe and, unless the learner turned it off (Settings → General → Short probe
 *  in cram mode), the short-probe instructions before it. */
export function withTeachingStyle(
	projectContext: string,
	record: Pick<ChatRecord, "style" | "kind" | "messages">,
	shortProbe = true,
): string {
	if (record.style !== "cram" || record.kind === "practice") return projectContext;
	const cram = hasProbeDone(record.messages) ? CRAM_INSTRUCTIONS : shortProbe ? CRAM_PROBE_INSTRUCTIONS : "";
	return [projectContext, cram].filter(Boolean).join("\n\n");
}
