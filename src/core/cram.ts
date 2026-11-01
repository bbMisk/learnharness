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
2. Walk through a different instance of the same class, showing how to recognise it and solve it step by step.
3. Ask the learner to solve the original instance: the problem they brought, or, if they brought none, a typical test instance of the class.
4. If they miss, name the gap, walk through another instance that targets it, and ask again. Repeat until they solve an instance correctly on their own, then move to the next class.

**Stay on the method, not the minutiae.** Focus on how to tackle other instances of the same class and of neighbouring classes. Don't get bogged down in small details. If the learner's approach is right but they made a careless slip (a sign, an arithmetic or a copying error), point it out in one line and move on; do not re-ask the question unless the learner asks for that.`;

/** The project instructions plus, for a cram lesson, the short-probe or the cram-loop instructions. */
export function withTeachingStyle(projectContext: string, record: Pick<ChatRecord, "style" | "kind" | "messages">): string {
	if (record.style !== "cram" || record.kind === "practice") return projectContext;
	const cram = hasProbeDone(record.messages) ? CRAM_INSTRUCTIONS : CRAM_PROBE_INSTRUCTIONS;
	return [projectContext, cram].filter(Boolean).join("\n\n");
}
