import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Display-only copy. Keep native history intact for model replay and exports.
 * The view reads tool-result text/details, never its inline image bytes or
 * the provider's opaque reasoning signature. */
export function clientMessage<T extends AgentMessage>(message: T): T {
	if (message.role === "assistant") {
		return { ...message, content: message.content.map(block => {
			if (block.type !== "thinking") return block;
			const { thinkingSignature: _signature, ...display } = block;
			return display;
		}) };
	}
	if (message.role === "toolResult") {
		return { ...message, content: message.content.filter(block => block.type !== "image") };
	}
	return message;
}
