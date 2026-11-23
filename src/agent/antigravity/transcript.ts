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

/** One message as the agent sees it: its labelled pieces (labelled even when alone), thinking dropped from the text. */
export interface ReplayedMessage {
	role: Message["role"];
	pieces: string[];
	/** An assistant message's thinking, verbatim: not sent, but part of what a session remembers. */
	thinking?: string[];
	/** What a lone user message is sent as: its plain text. */
	plain?: string;
}

/** What a parked agent session has already seen: the first `messages` messages, by a SHA-256 of their structure. */
export interface SeenFingerprint {
	systemText: string;
	modelId: string;
	messages: number;
	hash: string;
}

/**
 * The canonical encoding of a conversation prefix: one JSON entry per MESSAGE, [role, pieces, thinking],
 * so neither a character inside a piece nor the way pieces are split across messages can make two
 * different prefixes look alike.
 */
export function fingerprintHash(messages: readonly ReplayedMessage[]): string {
	return createHash("sha256").update(JSON.stringify(messages.map((message) => [message.role, message.pieces, message.thinking ?? []]))).digest("hex");
}

/** The assistant message a turn produced, replayed the way the next turn's input will show it. */
export function replayAssistant(content: Extract<Message, { role: "assistant" }>["content"]): ReplayedMessage {
	return replayed({ role: "assistant", content } as Message);
}

/**
 * What to send on a session that saw `seen`, or null when it can't be reused: same system text and
 * model, the conversation starts with exactly the messages it saw, and everything after is the
 * learner's (user or tool-result messages, at least one).
 */
export function reuseTail(seen: SeenFingerprint, input: AntigravityInput, modelId: string): string | null {
	if (seen.systemText !== input.systemText || seen.modelId !== modelId) return null;
	if (input.messages.length <= seen.messages) return null;
	if (fingerprintHash(input.messages.slice(0, seen.messages)) !== seen.hash) return null;
	const tail = input.messages.slice(seen.messages);
	if (tail.some((message) => message.role !== "user" && message.role !== "toolResult")) return null;
	const [only] = tail;
	if (tail.length === 1 && only?.role === "user" && only.plain !== undefined) return only.plain;
	return tail.flatMap((message) => message.pieces).join("\n\n");
}

function replayed(message: Message): ReplayedMessage {
	const thinking = message.role === "assistant" ? message.content.flatMap((block) => (block.type === "thinking" ? [block.thinking] : [])) : [];
	return {
		role: message.role,
		pieces: replay(message),
		...(thinking.length ? { thinking } : {}),
		...(message.role === "user" ? { plain: plain(message.content) } : {}),
	};
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
	return { systemText: system ? `${TEXT_ONLY_NOTE}\n\n${system}` : TEXT_ONLY_NOTE, transcript, messages: conversation.map(replayed) };
}
