/**
 * LearnHarness owns the transcript: every turn is a fresh agent session that
 * receives the whole conversation as text. The labels match the Claude Code
 * replay (claude-code/transcript.ts), which can't be reused as-is because it
 * forwards images. Here non-text content becomes a one-line placeholder and
 * thinking is dropped.
 */
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";

import { TEXT_ONLY_NOTE } from "./constants.ts";

export const OMITTED_IMAGE = "[image omitted: Antigravity is text-only here]";

export interface AntigravityInput {
	/** The text-only note, then the conversation's current system prompt. */
	systemText: string;
	/** The replayed conversation. */
	transcript: string;
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
	return { systemText: system ? `${TEXT_ONLY_NOTE}\n\n${system}` : TEXT_ONLY_NOTE, transcript };
}
