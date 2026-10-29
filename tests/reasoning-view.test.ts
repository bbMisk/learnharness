import assert from "node:assert/strict";
import { it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { projectView } from "../src/core/view.ts";

it("projects provider reasoning chunks as one phase and preserves signed native history", () => {
	const message = { ...fauxAssistantMessage([
		{ type: "thinking", thinking: "", thinkingSignature: "encrypted-1" },
		{ type: "thinking", thinking: "First summary", thinkingSignature: "encrypted-2" },
		{ type: "text", text: "The answer." },
		{ type: "thinking", thinking: "Second summary", thinkingSignature: "encrypted-3" },
		{ type: "thinking", thinking: "", thinkingSignature: "encrypted-4" },
	]), id: "reasoning-chunks" };
	const before = JSON.stringify(message);
	const view = projectView([message]);
	assert.equal(view[0]!.parts.filter((part) => part.type === "reasoning").length, 1);
	assert.equal(view[0]!.parts.find((part) => part.type === "reasoning")!.text, "First summary\n\nSecond summary");
	assert.equal(view[0]!.parts.find((part) => part.type === "text")!.text, "The answer.");
	assert.equal(JSON.stringify(message), before);
});
