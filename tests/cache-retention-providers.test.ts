/**
 * Cache retention per provider route (owner, 2026-11-01): ChatGPT picks the
 * field by model generation, Claude Code gets its own environment switches,
 * and the settings menu says what Long means for the slot's model.
 * No network, no CLI: the Claude Code launcher is a capturing fake.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, type CacheRetention, type Model, type Api } from "@earendil-works/pi-ai";

import { chatGPTCacheFields, chatGPTPayload, chatGPTStreamError } from "../src/agent/chatgpt-stream.ts";
import { claudeCacheEnv, createClaudeCodeStreamFunction, type RunClaude } from "../src/agent/claude-code/stream.ts";
import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { longRetentionNote } from "../components/settings/cache-retention-menu.tsx";

test("ChatGPT long retention picks the field by GPT generation; everything else sends nothing", () => {
	for (const id of ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6", "gpt-5.6", "gpt-5.6-codex"]) {
		assert.deepEqual(chatGPTCacheFields(id, "long"), { prompt_cache_options: { ttl: "12h" } }, id);
	}
	for (const id of ["gpt-5.5", "gpt-5.1-codex-max", "gpt-5", "gpt-4.1"]) {
		assert.deepEqual(chatGPTCacheFields(id, "long"), { prompt_cache_retention: "24h" }, id);
	}
	assert.deepEqual(chatGPTCacheFields("o4-mini", "long"), {});
	for (const retention of [undefined, "short", "none"] as const) assert.deepEqual(chatGPTCacheFields("gpt-6.1-terra", retention), {});
});

test("ChatGPT payload drops pi's own cache fields and adds the chosen one only with a cache key", () => {
	const raw = { input: [], prompt_cache_key: "chat-1", prompt_cache_retention: "24h", prompt_cache_options: { ttl: "30m" } };
	assert.deepEqual(chatGPTPayload(raw, "gpt-6.1-terra"), { model: "gpt-6.1-terra", store: false, stream: true, prompt_cache_key: "chat-1", input: [] });
	assert.deepEqual(chatGPTPayload(raw, "gpt-6.1-terra", "long"), { model: "gpt-6.1-terra", store: false, stream: true, prompt_cache_key: "chat-1", prompt_cache_options: { ttl: "12h" }, input: [] });
	assert.deepEqual(chatGPTPayload(raw, "gpt-5.5", "long"), { model: "gpt-5.5", store: false, stream: true, prompt_cache_key: "chat-1", prompt_cache_retention: "24h", input: [] });
	// Pi omits the key for "none"; no key means no cache field either.
	assert.deepEqual(chatGPTPayload({ input: [] }, "gpt-6.1-terra", "long"), { model: "gpt-6.1-terra", store: false, stream: true, input: [] });
});

test("a ChatGPT rejection of a cache field names the setting to change", () => {
	assert.match(chatGPTStreamError("400 Unsupported parameter: prompt_cache_options.ttl"), /Cache back to default/);
	assert.doesNotMatch(chatGPTStreamError("429 quota"), /Cache/);
});

test("Claude Code cache environment follows the slot setting; unset adds nothing", () => {
	assert.deepEqual(claudeCacheEnv(undefined), {});
	assert.deepEqual(claudeCacheEnv("long"), { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "1h" });
	assert.deepEqual(claudeCacheEnv("short"), { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m", CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m" });
	assert.deepEqual(claudeCacheEnv("none"), { DISABLE_PROMPT_CACHING: "1" });
});

test("the Claude Code stream launches the CLI with the request's cache retention", async () => {
	const model = CLAUDE_CODE_MODELS[0] as Model<Api>;
	const context = normalizeContext({ systemPrompt: "Stable", messages: [{ role: "user", content: "hi", timestamp: 1 }] });
	for (const retention of [undefined, "long", "none"] as (CacheRetention | undefined)[]) {
		let env: NodeJS.ProcessEnv | undefined;
		const runClaude: RunClaude = (_args, options) => { env = options.env; return null; };
		const stream = createClaudeCodeStreamFunction(runClaude);
		await stream(model, context, retention === undefined ? {} : { cacheRetention: retention }).result();
		assert.ok(env, "launcher was called");
		assert.equal(env.CLAUDE_CODE_PROMPT_CACHE_TTL, retention === "long" ? "1h" : process.env.CLAUDE_CODE_PROMPT_CACHE_TTL);
		assert.equal(env.DISABLE_PROMPT_CACHING, retention === "none" ? "1" : process.env.DISABLE_PROMPT_CACHING);
	}
});

test("the menu says what Long means for the slot's model", () => {
	assert.match(longRetentionNote("anthropic", "claude-opus-5-5")!, /1 hour.*Recommended/);
	assert.match(longRetentionNote("openrouter", "anthropic/claude-sonnet-5.5")!, /1 hour/);
	assert.match(longRetentionNote("claude-code", "opus")!, /subscription/);
	assert.match(longRetentionNote("chatgpt", "gpt-6.1-terra")!, /Keep the default/);
	assert.match(longRetentionNote("chatgpt", "gpt-5.5")!, /24 hours/);
	assert.equal(longRetentionNote("openrouter", "deepseek/v4"), undefined);
});
