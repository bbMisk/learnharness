/**
 * LearnHarness owns the transcript: a fresh agent session receives the whole
 * conversation as text, and a reused one only what it has not seen (the
 * canonical pieces below prove which). The labels match the Claude Code
 * replay (claude-code/transcript.ts). Images stay in place as parts: they go
 * out as ACP image blocks when the agent takes them (toPromptBlocks), else
 * as a one-line placeholder. Thinking is dropped.
 */
import { createHash } from "node:crypto";

import type { ImageContent, Message, TextContent, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";

import { TEXT_ONLY_NOTE, TOOLS_NOTE } from "./constants.ts";

export const OMITTED_IMAGE = "[image omitted: Antigravity is text-only here]";

/** A piece of replayed text, or an image that goes out in its place (as an ACP image block when the agent can take one). */
export type Part = string | ImageContent;

export interface AntigravityInput {
	/** The text-only note (or the tools note), then the conversation's current system prompt. */
	systemText: string;
	/** The replayed conversation, images as their placeholder. */
	transcript: string;
	/** The same, with the images in place. */
	transcriptParts: Part[];
	/** The conversation (system messages left out), one entry per message, for session reuse. */
	messages: ReplayedMessage[];
	/** The tools the session is given ("" for none): names, descriptions and schemas, hashed. */
	toolsHash: string;
}

/** One message as the agent sees it: its labelled pieces (labelled even when alone), thinking dropped from the text. */
export interface ReplayedMessage {
	role: Message["role"];
	/** Each piece's text, images as their placeholder. */
	pieces: string[];
	/** The same pieces with the images in place. */
	parts: Part[][];
	/** The SHA-256 of each image's bytes, in order (only when the message has images). */
	images?: string[];
	/** An assistant message's thinking, verbatim: not sent, but part of what a session remembers. */
	thinking?: string[];
	/** What a lone user message is sent as: its plain text. */
	plain?: string;
	plainParts?: Part[];
}

/** What a parked agent session has already seen: the first `messages` messages, by a SHA-256 of their structure. */
export interface SeenFingerprint {
	systemText: string;
	modelId: string;
	messages: number;
	hash: string;
	toolsHash: string;
	/** The fingerprint of the conversation's first message alone: a lesson keeps it across its phases. */
	firstHash?: string;
}

/** The fingerprint of a conversation's first message ("" for an empty one). */
export function firstMessageHash(messages: readonly ReplayedMessage[]): string {
	return messages.length ? fingerprintHash(messages.slice(0, 1)) : "";
}

/** The tools pi declares for this request (the source the Claude Code provider uses). */
export function declaredTools(messages: readonly Message[]): Tool[] {
	return getCurrentTools(messages);
}

/** A SHA-256 of the tools' declarations, in order; "" for no tools. */
export function toolsHash(tools: readonly Tool[]): string {
	if (!tools.length) return "";
	return createHash("sha256").update(JSON.stringify(tools.map(toToolDeclaration))).digest("hex");
}

/**
 * The canonical encoding of a conversation prefix: one JSON entry per MESSAGE, [role, pieces, thinking]
 * (and the images' hashes when there are any), so neither a character inside a piece nor the way pieces
 * are split across messages can make two different prefixes look alike, and an image is known by its bytes.
 */
export function fingerprintHash(messages: readonly ReplayedMessage[]): string {
	return createHash("sha256").update(JSON.stringify(messages.map((message) => {
		const entry: unknown[] = [message.role, message.pieces, message.thinking ?? []];
		if (message.images?.length) entry.push(message.images);
		return entry;
	}))).digest("hex");
}

/** The assistant message a turn produced, replayed the way the next turn's input will show it. */
export function replayAssistant(content: Extract<Message, { role: "assistant" }>["content"]): ReplayedMessage {
	return replayed({ role: "assistant", content } as Message);
}

/**
 * What to send on a session that saw `seen`, or null when it can't be reused: same system text,
 * model and tools, the conversation starts with exactly the messages it saw, and everything after is
 * the learner's (user or tool-result messages, at least one).
 */
export function reuseTailParts(seen: SeenFingerprint, input: AntigravityInput, modelId: string): Part[] | null {
	if (seen.systemText !== input.systemText || seen.modelId !== modelId || seen.toolsHash !== input.toolsHash) return null;
	if (input.messages.length <= seen.messages) return null;
	if (fingerprintHash(input.messages.slice(0, seen.messages)) !== seen.hash) return null;
	const tail = input.messages.slice(seen.messages);
	if (tail.some((message) => message.role !== "user" && message.role !== "toolResult")) return null;
	const [only] = tail;
	if (tail.length === 1 && only?.role === "user" && only.plainParts !== undefined) return only.plainParts;
	return joinParts(tail.flatMap((message) => message.parts), "\n\n");
}

/** reuseTailParts as text, images as their placeholder. */
export function reuseTail(seen: SeenFingerprint, input: AntigravityInput, modelId: string): string | null {
	const parts = reuseTailParts(seen, input, modelId);
	return parts === null ? null : renderParts(parts);
}

/** Text with each image as its placeholder. */
export function renderParts(parts: readonly Part[]): string {
	return parts.map((part) => (typeof part === "string" ? part : OMITTED_IMAGE)).join("");
}

function joinParts(groups: readonly Part[][], separator: string): Part[] {
	return groups.flatMap((group, index) => (index === 0 ? group : [separator, ...group]));
}

function imageHash(image: ImageContent): string {
	return createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex");
}

function replayed(message: Message): ReplayedMessage {
	const thinking = message.role === "assistant" ? message.content.flatMap((block) => (block.type === "thinking" ? [block.thinking] : [])) : [];
	const parts = replay(message);
	const images = parts.flat().filter((part): part is ImageContent => typeof part !== "string").map(imageHash);
	const plainParts = message.role === "user" ? contentParts(message.content) : undefined;
	return {
		role: message.role,
		pieces: parts.map(renderParts),
		parts,
		...(images.length ? { images } : {}),
		...(thinking.length ? { thinking } : {}),
		...(plainParts ? { plain: renderParts(plainParts), plainParts } : {}),
	};
}

/** A message's content in order, text blocks and images separated by newlines. */
function contentParts(content: string | (TextContent | ImageContent)[]): Part[] {
	if (typeof content === "string") return [content];
	return content.flatMap((block, index): Part[] => [...(index ? ["\n"] : []), block.type === "text" ? block.text : block]);
}

function labelled(label: string, content: string | (TextContent | ImageContent)[]): Part[] {
	const parts = contentParts(content);
	return renderParts(parts) ? [`${label}\n`, ...parts] : [label];
}

function replay(message: Message): Part[][] {
	switch (message.role) {
		case "system":
			return [];
		case "user":
			return [labelled("[user]", message.content)];
		case "assistant":
			return message.content.flatMap((block): Part[][] => {
				if (block.type === "text") return [[`[assistant]\n${block.text}`]];
				if (block.type === "toolCall") return [[`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`]];
				return [];
			});
		case "toolResult":
			return [labelled(message.isError ? `[tool result ${message.toolName} error]` : `[tool result ${message.toolName}]`, message.content)];
	}
}

/** `tools`: what the session is given; none means the text-only note, exactly as without tools support. */
export function toAntigravityInput(messages: Message[], tools: readonly Tool[] = []): AntigravityInput {
	const conversation = messages.filter((message) => message.role !== "system");
	const replayedMessages = conversation.map(replayed);
	const [first] = replayedMessages;
	const transcriptParts = replayedMessages.length === 1 && first?.plainParts
		? first.plainParts
		: joinParts(replayedMessages.flatMap((message) => message.parts), "\n\n");
	const system = getCurrentSystemPrompt(messages);
	const note = tools.length ? TOOLS_NOTE : TEXT_ONLY_NOTE;
	return { systemText: system ? `${note}\n\n${system}` : note, transcript: renderParts(transcriptParts), transcriptParts, messages: replayedMessages, toolsHash: toolsHash(tools) };
}

/** Test seam: the most image bytes one prompt carries; images beyond it go as their placeholder. */
export const promptImageLimit = { bytes: 20 * 1024 * 1024 };

export type PromptBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** ACP prompt blocks: text runs, and images as image blocks while `images` is on and the byte cap allows. */
export function toPromptBlocks(parts: readonly Part[], images: boolean): PromptBlock[] {
	const blocks: PromptBlock[] = [];
	let text = "";
	let bytes = 0;
	for (const part of parts) {
		if (typeof part === "string") { text += part; continue; }
		const size = Buffer.byteLength(part.data, "base64");
		if (!images || bytes + size > promptImageLimit.bytes) { text += OMITTED_IMAGE; continue; }
		bytes += size;
		if (text) blocks.push({ type: "text", text });
		text = "";
		blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
	}
	if (text || !blocks.length) blocks.push({ type: "text", text });
	return blocks;
}
