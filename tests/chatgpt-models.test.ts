import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { projectChatGPTModels } from "../src/core/chatgpt-models.ts";

const entry = {
	slug: "future-account-model", display_name: "Future account model", visibility: "list", supported_in_api: true,
	context_window: 500000, input_modalities: ["text", "image"],
	supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }, { effort: "ultra" }],
	service_tiers: [{ id: "priority" }],
};

describe("live ChatGPT model metadata", () => {
	it("offers a newly released ID absent from Pi, with exactly the supported runtime efforts", () => {
		const { models, fastTiers } = projectChatGPTModels([entry], []);
		assert.equal(models.length, 1);
		assert.equal(models[0]!.id, entry.slug);
		assert.equal(models[0]!.provider, "chatgpt");
		assert.equal(models[0]!.contextWindow, 500000);
		assert.equal(models[0]!.maxTokens, 0, "unknown output limits are not borrowed from a sibling");
		assert.deepEqual(getSupportedThinkingLevels(models[0]!), ["low", "high", "max"]);
		assert.deepEqual(fastTiers, { [entry.slug]: "priority" });
	});
	it("uses current account metadata over outdated exact-ID library capabilities", () => {
		const known = openaiProvider().getModels().find((m) => m.id === "gpt-6.1-sol")!;
		const { models } = projectChatGPTModels([{ ...entry, slug: known.id, max_output_tokens: 64000 }], [known]);
		assert.equal(models[0]!.contextWindow, 500000);
		assert.equal(models[0]!.maxTokens, 64000);
		assert.deepEqual(getSupportedThinkingLevels(models[0]!), ["low", "high", "max"]);
	});
	it("accepts sparse legacy entries only when the exact ID has a known definition", () => {
		const known = openaiProvider().getModels().find((m) => m.id === "gpt-6.1-sol")!;
		const { models } = projectChatGPTModels([{ slug: known.id, visibility: "list" }, { slug: "unmapped", visibility: "list" }], [known]);
		assert.deepEqual(models.map((m) => m.id), [known.id]);
		assert.equal(models[0]!.contextWindow, known.contextWindow);
	});
	it("rejects hidden, unavailable, malformed, or incompatible new entries and deduplicates IDs", () => {
		const { models, fastTiers } = projectChatGPTModels([
			null, {}, { ...entry, visibility: "hide" }, { ...entry, supported_in_api: false },
			{ ...entry, context_window: -1 }, { ...entry, input_modalities: ["audio"] },
			{ ...entry, supported_reasoning_levels: [{ effort: "ultra" }] },
			{ ...entry, supported_reasoning_levels: undefined }, entry, entry,
		], []);
		assert.deepEqual(models.map((m) => m.id), [entry.slug]);
		assert.deepEqual(Object.keys(fastTiers), [entry.slug]);
	});
	it("maps explicit none to off and handles non-reasoning text models", () => {
		const { models } = projectChatGPTModels([{ ...entry, supported_reasoning_levels: [{ effort: "none" }, { effort: "low" }] }], []);
		assert.deepEqual(getSupportedThinkingLevels(models[0]!), ["off", "low"]);
		assert.equal(models[0]!.thinkingLevelMap?.off, "none");
		const flat = projectChatGPTModels([{ ...entry, supported_reasoning_levels: [] }], []).models[0]!;
		assert.equal(flat.reasoning, false);
		assert.deepEqual(getSupportedThinkingLevels(flat), ["off"]);
	});
});
