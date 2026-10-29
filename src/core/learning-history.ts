/** Raw learning history, independent of any future review scheduler. */
import type { LhMessage } from "./native-messages.ts";
import { QUESTION_TOOLS } from "./pending.ts";

export interface LearningEvent {
	version: 1;
	id: string;
	kind: "question-posed" | "question-answered" | "practice-posed" | "practice-thinking" | "practice-concluded" | "practice-dismissed" | "learner-message";
	/** Original native-message time, not page exposure or active study time. */
	at: string | null;
	messageId: string;
	/** A question/problem instance. A future reusable card needs its own ID. */
	itemId?: string;
	tool?: string;
	/** Only explicit graph targets. Plan nodes occupy a separate namespace. */
	graphNodeIds: string[];
	planNodeId?: string;
	outcome?: string;
	/** Frozen question, answer, thinking or conclusion data as recorded. */
	payload: Record<string, unknown>;
}

const recordOf = (v: unknown): Record<string, unknown> | undefined =>
	v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

function messageTime(timestamp: number): string | null {
	const date = new Date(timestamp);
	return Number.isFinite(timestamp) && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Idempotent capture; previously recorded facts survive compaction and replay. */
export function mergeLearningEvents(previous: readonly LearningEvent[] | undefined, messages: readonly LhMessage[]): LearningEvent[] {
	if (previous !== undefined && !Array.isArray(previous)) throw new Error("Invalid learning history: expected an event array");
	const events = new Map((previous ?? []).map(event => [event.id, event]));
	const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
	const results = new Map(messages.flatMap(message => message.role === "toolResult" ? [[message.toolCallId, message] as const] : []));
	let activeProblem: string | undefined;
	let previousActive: string | undefined;
	const recordedConclusions = new Set<string>();
	for (const event of previous ?? []) {
		if ((event.kind === "question-posed" || event.kind === "practice-posed") && event.itemId && event.tool) {
			calls.set(event.itemId, { name: event.tool, input: event.payload });
		}
		if (event.kind === "practice-posed") previousActive = event.itemId;
		if (event.kind === "practice-concluded" || event.kind === "practice-dismissed") {
			recordedConclusions.add(event.messageId);
			if (event.itemId === previousActive) previousActive = undefined;
		}
	}
	const targets = (itemId: string | undefined): string[] => {
		const target = itemId ? calls.get(itemId)?.input.target : undefined;
		return Array.isArray(target) ? target.filter((id): id is string => typeof id === "string") : [];
	};
	const add = (message: LhMessage, kind: LearningEvent["kind"], payload: Record<string, unknown>, itemId?: string, tool?: string, outcome?: string) => {
		const id = `${kind}:${itemId ?? message.id}`;
		// Thinking submissions share a problem: each message is its own event.
		const eventId = kind === "practice-thinking" ? `${kind}:${message.id}` : id;
		if (events.has(eventId)) return;
		const planNodeId = itemId ? calls.get(itemId)?.input.nodeId : undefined;
		events.set(eventId, {
			version: 1, id: eventId, kind, at: messageTime(message.timestamp), messageId: message.id,
			...(itemId ? { itemId } : {}), ...(tool ? { tool } : {}),
			graphNodeIds: tool === "problem" || kind.startsWith("practice-") ? targets(itemId) : [],
			...(typeof planNodeId === "string" ? { planNodeId } : {}),
			...(outcome ? { outcome } : {}), payload: structuredClone(payload),
		});
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const input = recordOf(block.arguments);
				if (!input) continue;
				calls.set(block.id, { name: block.name, input });
				if ((QUESTION_TOOLS as readonly string[]).includes(block.name) && !results.get(block.id)?.isError) {
					add(message, "question-posed", input, block.id, block.name);
				}
			}
		} else if (message.role === "toolResult" && !message.isError) {
			const call = calls.get(message.toolCallId);
			if (!call) continue;
			if ((QUESTION_TOOLS as readonly string[]).includes(call.name)) {
				const answer = recordOf(message.details);
				if (!answer || typeof answer.kind !== "string" || typeof answer.questionText !== "string") continue;
				const outcome = answer.dismissed === true ? "dismissed" : answer.dontKnow === true ? "dont-know" :
					typeof answer.correct === "boolean" ? (answer.correct ? "correct" : "incorrect") : "ungraded";
				add(message, "question-answered", answer, message.toolCallId, call.name, outcome);
			} else if (call.name === "problem") {
				activeProblem = message.toolCallId;
				add(message, "practice-posed", call.input, activeProblem, call.name);
			} else if (call.name === "conclude") {
				const itemId = activeProblem ?? previousActive;
				if (itemId && !recordedConclusions.has(message.id)) {
					add(message, "practice-concluded", call.input, itemId, call.name, typeof call.input.outcome === "string" ? call.input.outcome : undefined);
					if (itemId === previousActive) previousActive = undefined;
				}
				activeProblem = undefined;
			}
		} else if (message.role === "custom") {
			const details = recordOf(message.details);
			if (!details || typeof details.problemCallId !== "string") continue;
			if (message.customType === "practice-thinking") add(message, "practice-thinking", details, details.problemCallId);
			if (message.customType === "problem-dismissed") {
				add(message, "practice-dismissed", details, details.problemCallId, undefined, "dismissed");
				activeProblem = undefined;
			}
		} else if (message.role === "user") {
			const text = typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
			add(message, "learner-message", { text });
		}
	}
	return [...events.values()];
}
