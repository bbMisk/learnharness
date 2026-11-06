import { weakSpotsPracticePrompt } from "@/src/core";
import { clearOpeningPrompt, OPENING_PROMPT_FAILURE, stashOpeningPrompt } from "./opening-prompt";

interface SessionCreation {
	title: string;
	kind?: "practice";
	projectId?: string;
	/** Cram mode (core/cram.ts): a lesson with a short probe and the test-focused loop. */
	style?: "cram";
	graphContext?: { propositions: readonly { id: string; name: string; statement: string }[] };
}

/** Per source-composer instance. Retain a successful creation if storage
 * fails, so an unchanged retry does not create another empty session.
 * Changed text/context/settings is a different start, not a stale title.
 */
export class SessionStarter {
	private created?: { identity: string; id: string };

	async start(body: SessionCreation, fetchLike: typeof fetch, settingsIdentity?: string): Promise<string> {
		const identity = JSON.stringify([body, settingsIdentity]);
		if (this.created?.identity !== identity) {
			if (this.created) clearOpeningPrompt(this.created.id);
			this.created = undefined;
			const res = await fetchLike("/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error(OPENING_PROMPT_FAILURE);
			const result = await res.json() as { id?: unknown };
			if (typeof result.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(result.id)) throw new Error(OPENING_PROMPT_FAILURE);
			this.created = { identity, id: result.id };
		}
		if (!stashOpeningPrompt(this.created.id, body.title)) throw new Error(OPENING_PROMPT_FAILURE);
		return `/chat/${this.created.id}`;
	}
}

/** "Practice weak spots" (the Progress card's button): a new practice
 *  session in the lesson's project, opened by the weak-spots message. */
export function startWeakSpotsPractice(
	lesson: string,
	spots: readonly string[],
	projectId: string | undefined,
	fetchLike: typeof fetch,
	starter = new SessionStarter(),
): Promise<string> {
	return starter.start({ title: weakSpotsPracticePrompt(lesson, spots), kind: "practice", ...(projectId ? { projectId } : {}) }, fetchLike);
}
