/**
 * Cram mode (owner, 2026-11-01): after the probe, the learner chooses how the
 * rest of the session runs — Teach (the full method) or Cram (test-focused).
 * The choice is stored on the chat (`style: "cram"`) and, once the probe has
 * concluded, these instructions ride the teacher's system prompt after the
 * base method, which they override where the two conflict.
 */
import type { ChatRecord } from "./contracts/chat.ts";
import { hasProbeDone } from "./native-messages.ts";

export type TeachingStyle = "teach" | "cram";

/** What the two plan-phase buttons send as the learner's go-ahead. */
export const STYLE_GO_AHEAD: Record<TeachingStyle, string> = {
	teach: "The plan looks good. Teach it.",
	cram: "Let's cram: get me test-ready on this.",
};

export const CRAM_INSTRUCTIONS = `# Cram mode

The learner chose cram mode. The goal is simple: do well on a test on this material. Where this section conflicts with the teaching method above, this section wins.

**The plan is short.** Its nodes are the classes of problems the test can ask (classes, not individual instances) and the concepts needed to solve any instance of each class. If the current plan was built for full teaching, first trim it to that shape, then start.

**For each class, run this loop:**
1. State the class of problem, the intuition behind it, and the definitions needed to solve it. Briefly.
2. Walk through a different instance of the same class, showing how to recognise it and solve it step by step.
3. Ask the learner to solve the original instance: the problem they brought, or, if they brought none, a typical test instance of the class.
4. If they miss, name the gap, walk through another instance that targets it, and ask again. Repeat until they solve an instance correctly on their own, then move to the next class.

**Stay on the method, not the minutiae.** Focus on how to tackle other instances of the same class and of neighbouring classes. Don't get bogged down in small details. If the learner's approach is right but they made a careless slip (a sign, an arithmetic or a copying error), point it out in one line and move on; do not re-ask the question unless the learner asks for that.`;

/** The project instructions plus, for a cram session past its probe, the cram doctrine. */
export function withTeachingStyle(projectContext: string, record: Pick<ChatRecord, "style" | "kind" | "messages">): string {
	if (record.style !== "cram" || record.kind === "practice" || !hasProbeDone(record.messages)) return projectContext;
	return [projectContext, CRAM_INSTRUCTIONS].filter(Boolean).join("\n\n");
}
