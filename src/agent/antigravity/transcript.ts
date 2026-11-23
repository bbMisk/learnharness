/**
 * LearnHarness owns the transcript: a fresh agent session receives the whole
 * conversation as text, and a reused one only what it has not seen (the
 * canonical pieces below prove which). The labels match the Claude Code
 * replay (claude-code/transcript.ts), which can't be reused as-is because it
 * forwards images. Here non-text content becomes a one-line placeholder and
 * thinking is dropped.
 */
import { createHash } from "node:crypto";

import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";

import { TEXT_ONLY_NOTE } from "./constants.ts";

export const OMITTED_IMAGE = "[image omitted: Antigravity is text-only here]";

export interface AntigravityInput {
	/** The text-only note, then the conversation's current system prompt. */
	systemText: string;
	/** The replayed conversation. */
	transcript: string;
	/** The conversation (system messages left out), one entry per message, for session reuse. */
	messages: ReplayedMessage[];
}

/** One message as the agent sees it: its labelled pieces (labelled even when alone), thinking dropped. */
export interface ReplayedMessage {
	role: Message["role"];
	pieces: string[];
	/** What a lone user message is sent as: its plain text. */
	plain?: string;
}

/** What a parked agent session has already seen. */
export interface SeenFingerprint {
	systemText: string;
	modelId: string;
	/** Canonical pieces seen, and a SHA-256 over them. */
	count: number;
	hash: string;
}

/** Every message contributes at least one canonical piece (its role marks it), so no message is invisible. */
export function canonicalPieces(messages: readonly ReplayedMessage[]): string[] {
	return messages.flatMap((message) => (message.pieces.length ? message.pieces : [""]).map((piece) => `${message.role}\u0001${piece}`));
}

export function hashPieces(pieces: readonly string[]): string {
	return createHash("sha256").update(pieces.join("\u0000")).digest("hex");
}

/** The assistant message a turn produced, replayed the way the next turn's input will show it. */
export function replayAssistant(content: Extract<Message, { role: "assistant" }>["content"]): ReplayedMessage {
	return { role: "assistant", pieces: replay({ role: "assistant", content } as Message) };
}

/**
 * What to send on a session that saw `seen`, or null when it can't be reused: same system text and
 * model, the conversation starts with exactly what it saw (ending on a message boundary), and
 * everything after is the learner's (user or tool-result messages, at least one).
 */
export function reuseTail(seen: SeenFingerprint, input: AntigravityInput, modelId: string): string | null {
	if (seen.systemText !== input.systemText || seen.modelId !== modelId) return null;
	let boundary = 0;
	let consumed = 0;
	while (consumed < seen.count && boundary < input.messages.length) {
		consumed += Math.max(1, input.messages[boundary]!.pieces.length);
		boundary++;
	}
	if (consumed !== seen.count) return null; // the prefix would end inside a message
	const pieces = canonicalPieces(input.messages);
	if (hashPieces(pieces.slice(0, seen.count)) !== seen.hash) return null;
	const tail = input.messages.slice(boundary);
	if (tail.length === 0 || tail.some((message) => message.role !== "user" && message.role !== "toolResult")) return null;
	const [only] = tail;
	if (tail.length === 1 && only?.role === "user" && only.plain !== undefined) return only.plain;
	return tail.flatMap((message) => message.pieces).join("\n\n");
}

function plain(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : OMITTED_IMAGE)).join("\n");
}

function labelled(label: string, content: string | (TextContent | ImageContent)[]): string {
	const text = plain(content);
	return text ? `${label}\n${text}` : label;
}

function replay(message: Message): string[] {
	switch (message.role) {
		case "system":
			return [];
		case "user":
			return [labelled("[user]", message.content)];
		case "assistant":
			return message.content.flatMap((block) => {
				if (block.type === "text") return [`[assistant]\n${block.text}`];
				if (block.type === "toolCall") return [`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`];
				return [];
			});
		case "toolResult":
			return [labelled(message.isError ? `[tool result ${message.toolName} error]` : `[tool result ${message.toolName}]`, message.content)];
	}
}

export function toAntigravityInput(messages: Message[]): AntigravityInput {
	const conversation = messages.filter((message) => message.role !== "system");
	const [first] = conversation;
	const transcript = conversation.length === 1 && first?.role === "user"
		? plain(first.content)
		: conversation.flatMap(replay).join("\n\n");
	const system = getCurrentSystemPrompt(messages);
	const replayed = conversation.map((message): ReplayedMessage => ({
		role: message.role,
		pieces: replay(message),
		...(message.role === "user" ? { plain: plain(message.content) } : {}),
	}));
	return { systemText: system ? `${TEXT_ONLY_NOTE}\n\n${system}` : TEXT_ONLY_NOTE, transcript, messages: replayed };
}
