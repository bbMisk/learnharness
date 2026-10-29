import type { LhMessage } from "./native-messages.ts";
import { projectView } from "./view.ts";
import type { EffectiveModelSpec } from "./settings-resolution.ts";

export interface SideMessage { role: "user" | "assistant"; content: string }
export interface SideSnapshot { context: string; truncated: boolean; model: EffectiveModelSpec }
export type SideFrame = { type: "delta"; text: string } | { type: "done" } | { type: "error"; error: string };
export const SIDE_CONTEXT_LIMIT = 200_000;

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Error pages from a restarting host need not be JSON. Keep their status
 * instead of replacing the transport failure with a browser parse error. */
export function parseSideJSONResponse(text: string, status: number): unknown {
	const fallback = `The side tutor returned an unreadable response (HTTP ${status}). Try again.`;
	let body: unknown;
	try { body = JSON.parse(text); } catch { throw new Error(fallback); }
	if (status < 200 || status >= 300) throw new Error(object(body) && typeof body.error === "string" ? body.error : fallback);
	return body;
}

/** A learner-visible snapshot, never a raw tool transcript. In particular,
 * unanswered quizzes' answer keys, explain commitments, practice solutions,
 * agent reasoning, file contents, and private instructions stay out. */
export function sideLessonContext(messages: readonly LhMessage[], title: string): { context: string; truncated: boolean } {
	const blocks: string[] = [];
	for (const message of projectView(messages)) {
		for (const part of message.parts) {
			if (part.type === "text" && typeof part.text === "string") {
				blocks.push(`${message.role === "user" ? "Learner" : "Teacher"}:\n${part.text}`);
				continue;
			}
			if (part.state === "output-error" || !object(part.input)) continue;
			if (["tool-quiz", "tool-probe", "tool-explain", "tool-recall", "tool-ask_user_question"].includes(part.type)) {
				const input = part.input;
				if (typeof input.question === "string") blocks.push(`Question:\n${input.question}`);
				if (typeof input.context === "string") blocks.push(input.context);
				if (Array.isArray(input.options)) {
					const labels = input.options.flatMap((v) => typeof v === "string" ? [v] : object(v) && typeof v.label === "string" ? [v.label] : []);
					if (labels.length) blocks.push(labels.map((v) => `- ${v}`).join("\n"));
				}
				// Only the learner's own submitted words; no answer-key fields.
				if (object(part.output)) {
					for (const key of ["text", "thinking", "readingThinking", "note", "other"] as const) {
						if (typeof part.output[key] === "string") blocks.push(`Learner (${key}): ${part.output[key]}`);
					}
				}
			} else if (part.type === "tool-problem" && typeof part.input.statement === "string") {
				blocks.push(`Practice problem:\n${part.input.statement}`);
			}
		}
	}
	const text = blocks.join("\n\n");
	const truncated = text.length > SIDE_CONTEXT_LIMIT - title.length - 100;
	const budget = Math.max(0, SIDE_CONTEXT_LIMIT - title.length - 100);
	return { context: `Lesson: ${title}\n\n${truncated ? "[Earlier lesson text omitted.]\n\n" : ""}${text.slice(-budget)}`, truncated };
}

/** Side history is plain text with no client-supplied system/tool roles. */
export function parseSideRequest(raw: unknown): { snapshot: SideSnapshot; messages: SideMessage[] } | null {
	if (!object(raw) || !object(raw.snapshot)) return null;
	const s = raw.snapshot;
	if (typeof s.context !== "string" || s.context.length > SIDE_CONTEXT_LIMIT || !object(s.model)) return null;
	if (typeof s.model.provider !== "string" || typeof s.model.id !== "string" || !s.model.provider || !s.model.id) return null;
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	if (s.model.thinkingLevel !== undefined && !levels.includes(String(s.model.thinkingLevel))) return null;
	if (!Array.isArray(raw.messages) || raw.messages.length < 1 || raw.messages.length > 40) return null;
	const messages: SideMessage[] = [];
	for (const [i, m] of raw.messages.entries()) {
		if (!object(m) || m.role !== (i % 2 === 0 ? "user" : "assistant") || typeof m.content !== "string" || !m.content.trim() || m.content.length > 20_000) return null;
		messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: m.content });
	}
	if (messages.at(-1)?.role !== "user") return null;
	return { snapshot: { context: s.context, truncated: s.truncated === true, model: s.model as unknown as EffectiveModelSpec }, messages };
}
