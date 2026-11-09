import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import type { ModelCatalogEntry } from "../src/core/index.ts";

const model = (id: string, contextWindow: number | null): ModelCatalogEntry => ({
	id, name: id, provider: "openai", reasoning: false, input: ["text"], supportedLevels: ["off"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 1024,
});
const order = (html: string) => [...html.matchAll(/data-testid="model-option-([^"]+)"/g)].map((m) => m[1]);

it("setup's model menu sinks tiny-context models below the rest (Enter picks the first row)", () => {
	const models = [model("gpt-4", 8192), model("gpt-5", 400_000), model("local", null)];
	assert.deepEqual(order(renderToStaticMarkup(<ModelMenuList models={models} effectiveId={undefined} onPick={() => {}} minContext={32_000} />)), ["gpt-5", "local", "gpt-4"]);
	assert.deepEqual(order(renderToStaticMarkup(<ModelMenuList models={models} effectiveId={undefined} onPick={() => {}} />)), ["gpt-4", "gpt-5", "local"], "other pickers keep plain order");
});
