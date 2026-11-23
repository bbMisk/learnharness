/**
 * The production parsers and one whole turn fed the frames of a real
 * session, captured from agy acp 1.5.15 on 2026-11-23 and sanitized
 * (tests/fixtures/antigravity/real-agy-1.5.15.json). The turn runs on the
 * mock agent replaying that capture (scenario `realCapture`); the real
 * binary is never started.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import type { AntigravityHost } from "../src/agent/antigravity/host.ts";
import { findConfigOption, modelsFrom, toPiModel, type AgentModel } from "../src/agent/antigravity/models.ts";
import { AntigravityRuntime, parseHandshake } from "../src/agent/antigravity/runtime.ts";
import { createAntigravityStreamFunction } from "../src/agent/antigravity/stream.ts";
import { antigravitySwitchOn } from "../src/core/fork-config.ts";
import { mockHarness } from "./helpers/antigravity-mock.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

const CAPTURE = fileURLToPath(new URL("./fixtures/antigravity/real-agy-1.5.15.json", import.meta.url));
const real = JSON.parse(readFileSync(CAPTURE, "utf8")) as {
	initialize: unknown;
	sessionNew: { configOptions: { id: string; options: { value: string }[] }[]; models: { availableModels: { modelId: string }[] }; modes: unknown };
	setConfigOption: { configOptions: unknown[] };
	promptResult: { usage: { inputTokens: number; outputTokens: number } };
	notifications: Record<string, { params: { update: { sessionUpdate: string } } }>;
};

test("the real initialize is accepted: protocol 1, append and close advertised, version 1.5.15", () => {
	assert.equal((real.initialize as { protocolVersion: number }).protocolVersion, 1);
	assert.deepEqual(parseHandshake(real.initialize), { agentVersion: "1.5.15", systemPromptAppend: true, sessionClose: true });
});

test("the model list is the configOptions model option (9 ids), never the legacy availableModels list", () => {
	const option = real.sessionNew.configOptions.find((o) => o.id === "model")!;
	const expected = option.options.map((o) => o.value);
	assert.equal(expected.length, 9);
	const listed = modelsFrom(real.sessionNew)!;
	assert.deepEqual(listed.map((m) => m.id), expected);
	const legacy = real.sessionNew.models.availableModels.map((m) => m.modelId);
	assert.ok(legacy.includes("gemini-4-neon-high"));
	assert.equal(listed.some((m) => legacy.includes(m.id) && !expected.includes(m.id)), false, "no legacy-only id leaks in");
	assert.equal(listed.some((m) => m.id === "gemini-4-neon-high"), false);
});

test("the real session starts in mode \"default\", and the real set_config_option answer confirms mode and model", () => {
	assert.equal(findConfigOption(real.sessionNew.configOptions, "mode")?.currentValue, "default");
	assert.equal(findConfigOption(real.setConfigOption.configOptions, "mode")?.currentValue, "default");
	assert.equal(findConfigOption(real.setConfigOption.configOptions, "model")?.currentValue, "gemini-3.8-flash");
});

test("a whole turn on the captured frames: model set and confirmed, every captured notification kind handled, only the message chunk is text", async (t) => {
	const kinds = Object.values(real.notifications).map((n) => n.params.update.sessionUpdate).sort();
	assert.deepEqual(kinds, ["agent_message_chunk", "available_commands_update", "config_option_update", "session_info_update", "usage_update"]);
	const h = mockHarness(t, { realCapture: CAPTURE });
	const tempBase = mkdtempSync(join(tmpdir(), "lh-agy-real-"));
	const runtime = new AntigravityRuntime({ launch: h.launch, tempBase });
	h.onTeardown(() => runtime.shutdown());
	t.after(() => rmSync(tempBase, { recursive: true, force: true }));
	const saved: AgentModel[][] = [];
	const host: AntigravityHost = { available: () => true, models: () => [], saveModels: (models) => saved.push(models) };
	const stream = createAntigravityStreamFunction({ runtime: () => runtime, host: () => host })(
		toPiModel({ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }),
		normalizeContext({ messages: [{ role: "user", content: "Reply with exactly the single word: pong", timestamp: 0 }] }),
	);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const final = await stream.result();
	assert.equal(final.stopReason, "stop", final.errorMessage);
	assert.deepEqual(final.content, [{ type: "text", text: "pong" }]);
	assert.deepEqual(events.map((e) => e.type), ["start", "text_start", "text_delta", "text_end", "done"]);
	const usage = real.promptResult.usage;
	assert.deepEqual([final.usage.input, final.usage.output, final.usage.totalTokens], [usage.inputTokens, usage.outputTokens, usage.inputTokens + usage.outputTokens]);
	const methods = h.methods().filter((m) => m !== "session/close");
	assert.deepEqual(methods, ["initialize", "session/new", "session/set_config_option", "session/prompt"], "the mode was already \"default\": only the model is set");
	const set = h.received().find((m) => m.method === "session/set_config_option")!.params as { configId: string; value: string };
	assert.deepEqual([set.configId, set.value], ["model", "gemini-3.8-flash"]);
	assert.equal(saved[0]?.length, 9, "the 9 config-option models were saved");
});

test("the server switch: on by default, LH_FORK_ANTIGRAVITY=0 forces off, =1 forces on, anything else keeps the default", (t) => {
	const previous = process.env.LH_FORK_ANTIGRAVITY;
	t.after(() => { if (previous === undefined) delete process.env.LH_FORK_ANTIGRAVITY; else process.env.LH_FORK_ANTIGRAVITY = previous; });
	delete process.env.LH_FORK_ANTIGRAVITY;
	assert.equal(antigravitySwitchOn(), true);
	for (const [value, on] of [["0", false], ["1", true], ["", true], ["false", true], ["yes", true]] as const) {
		process.env.LH_FORK_ANTIGRAVITY = value;
		assert.equal(antigravitySwitchOn(), on, JSON.stringify(value));
	}
});
