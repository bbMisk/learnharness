/**
 * Thinking levels for Antigravity (docs/antigravity.md): learned per model at
 * Check connection, persisted next to each model, turned into pi reasoning
 * models for the picker, and set on the agent before a lesson's prompt. All
 * against the mock agent, whose per-model levels follow the real capture.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test, type TestContext } from "node:test";

import { clampThinkingLevel, getSupportedThinkingLevels, type AssistantMessage, type ThinkingLevel } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import type { LaunchAgent } from "../src/agent/antigravity/binary.ts";
import { MOCK_AGY, mockHarness, waitFor, type MockHarness, type MockScenario } from "./helpers/antigravity-mock.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

// Isolation first: no ambient keys, data, network. Every import that reads them follows.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-thinking-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), LH_FORK_ANTIGRAVITY: "1", LH_AGY_BINARY: MOCK_AGY };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };

const { AntigravityRuntime, antigravityTimeouts } = await import("../src/agent/antigravity/runtime.ts");
const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-thinking-run-"));
let launch: LaunchAgent | undefined;
const globalRuntime = new AntigravityRuntime({ launch: (args, options) => launch?.(args, options) ?? null, tempBase });
(globalThis as Record<symbol, unknown>)[Symbol.for("lh.antigravity.runtime")] = globalRuntime;

const { AntigravityMessage } = await import("../src/agent/antigravity/constants.ts");
const { levelsFrom, sanitizeLevels, toPiModel } = await import("../src/agent/antigravity/models.ts");
const { checkAntigravityAgent } = await import("../src/agent/antigravity/provider.ts");
const { createAntigravityStreamFunction } = await import("../src/agent/antigravity/stream.ts");
const { piModels, piEngineForSpec } = await import("../src/agent/models.ts");
const { modelCatalog, clampChatLevel } = await import("../src/server/model-catalog.ts");
const { checkAntigravityConnection } = await import("../src/server/antigravity.ts");
const { antigravityStore, ANTIGRAVITY_FILE, createAntigravityStore } = await import("../src/store/antigravity.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");

after(() => {
	globalRuntime.shutdown();
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	fs.rmSync(directory, { recursive: true, force: true });
	fs.rmSync(tempBase, { recursive: true, force: true });
});

const CAPTURE = fileURLToPath(new URL("./fixtures/antigravity/real-agy-1.5.15.json", import.meta.url));
const real = JSON.parse(fs.readFileSync(CAPTURE, "utf8")) as { sessionNew: { configOptions: unknown[] }; setConfigOption: { configOptions: unknown[] } };
const DEFAULTS = { ...antigravityTimeouts };
const PRO = toPiModel({ id: "gemini-3-pro", name: "Gemini 3 Pro", levels: ["low", "medium", "high", "xhigh"] });
const FLASH = toPiModel({ id: "gemini-3-flash", name: "Gemini 3 Flash", levels: ["low", "medium", "high"] });
const HI = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

function runtimeFor(t: TestContext, scenario: MockScenario = {}) {
	const h = mockHarness(t, scenario);
	const runtime = new AntigravityRuntime({ launch: h.launch, tempBase });
	h.onTeardown(() => runtime.shutdown());
	t.after(() => Object.assign(antigravityTimeouts, DEFAULTS));
	return { h, runtime };
}

async function turn(t: TestContext, scenario: MockScenario, model: typeof PRO, reasoning?: ThinkingLevel): Promise<{ final: AssistantMessage; h: MockHarness }> {
	const { h, runtime } = runtimeFor(t, scenario);
	const stream = createAntigravityStreamFunction({ runtime: () => runtime, host: () => ({ available: () => true, models: () => [], saveModels: () => {} }) })(model, HI, reasoning ? { reasoning } : {});
	for await (const _event of stream) { /* drain */ }
	return { final: await stream.result(), h };
}

/** The (configId, value) of every set_config_option, and where the prompt went, in the order the mock received them. */
function wire(h: MockHarness) {
	const received = h.received().filter((m) => typeof m.method === "string");
	const sets = received.flatMap((m, index) => (m.method === "session/set_config_option" ? [{ index, id: (m.params as { configId: string }).configId, value: (m.params as { value: string }).value }] : []));
	return { sets, prompt: received.findIndex((m) => m.method === "session/prompt") };
}

test("the real capture's thought_level option parses per model: neon low..xhigh, flash low..high, default high", () => {
	assert.deepEqual(levelsFrom(real.sessionNew.configOptions), { levels: ["low", "medium", "high", "xhigh"], defaultLevel: "high" });
	assert.deepEqual(levelsFrom(real.setConfigOption.configOptions), { levels: ["low", "medium", "high"], defaultLevel: "high" });
	assert.deepEqual(sanitizeLevels(["low", "HIGH", "has space", "x".repeat(33), "ok_1-2", "low", 3]), ["low", "ok_1-2"]);
});

test("model definition: offered levels map by exact name, no off, the lowest is the floor; no levels means no reasoning", () => {
	assert.deepEqual(getSupportedThinkingLevels(PRO), ["low", "medium", "high", "xhigh"]);
	assert.deepEqual(getSupportedThinkingLevels(FLASH), ["low", "medium", "high"]);
	assert.deepEqual(PRO.thinkingLevelMap, { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null });
	assert.equal(clampThinkingLevel(FLASH, "off"), "low");
	assert.equal(clampThinkingLevel(FLASH, "minimal"), "low");
	assert.equal(clampThinkingLevel(FLASH, "max"), "high");
	assert.equal(clampThinkingLevel(PRO, "max"), "xhigh");
	for (const levels of [[], ["turbo"], undefined]) {
		const plain = toPiModel({ id: "plain", name: "Plain", ...(levels ? { levels } : {}) });
		assert.equal(plain.reasoning, false, JSON.stringify(levels));
		assert.deepEqual(getSupportedThinkingLevels(plain), ["off"]);
	}
});

test("Check connection learns each model's levels by selecting it on a throwaway session; nothing else is changed", async (t) => {
	const list = [
		{ value: "gemini-3-pro", name: "Gemini 3 Pro", levels: ["low", "medium", "high", "xhigh"] },
		{ value: "gemini-3-flash", name: "Gemini 3 Flash", levels: ["low", "medium", "high"], defaultLevel: "medium" },
		{ value: "plain", name: "Plain", levels: [] },
		{ value: "refused", name: "Refused", levels: ["low"] },
		{ value: "odd", name: "Odd", levels: ["low", "Turbo Max"] },
	];
	const { h, runtime } = runtimeFor(t, { sessionClose: true, models: { list }, refuseModels: ["refused"] });
	const result = await checkAntigravityAgent(runtime);
	assert.deepEqual(result.models, [
		{ id: "gemini-3-pro", name: "Gemini 3 Pro", levels: ["low", "medium", "high", "xhigh"], defaultLevel: "high" },
		{ id: "gemini-3-flash", name: "Gemini 3 Flash", levels: ["low", "medium", "high"], defaultLevel: "medium" },
		{ id: "plain", name: "Plain", levels: [] },
		{ id: "refused", name: "Refused", levels: [] },
		{ id: "odd", name: "Odd", levels: ["low"] },
	]);
	// One model selection per non-current model; never a level, a mode or a prompt.
	assert.deepEqual(wire(h).sets.map((s) => [s.id, s.value]), [["model", "gemini-3-flash"], ["model", "plain"], ["model", "refused"], ["model", "odd"]]);
	assert(!h.methods().includes("session/prompt"));
	await waitFor(() => h.methods().includes("session/close"), 3000, "the throwaway session is closed");
});

test("levels persist next to each model, survive a restart, and an old file without levels still loads", async (t) => {
	antigravityStore.update({ enabled: true, models: [] });
	const { runtime } = runtimeFor(t);
	const status = await checkAntigravityConnection(() => checkAntigravityAgent(runtime));
	assert.equal(status.models, 2);
	const restarted = createAntigravityStore(ANTIGRAVITY_FILE).read();
	assert.deepEqual(restarted.models.map((m) => [m.id, m.levels, m.defaultLevel]), [["gemini-3-pro", ["low", "medium", "high", "xhigh"], "high"], ["gemini-3-flash", ["low", "medium", "high"], "high"]]);
	const old = path.join(directory, "old-antigravity.json");
	fs.writeFileSync(old, JSON.stringify({ version: 1, enabled: true, models: [{ id: "legacy-entry", name: "Old" }] }));
	assert.deepEqual(createAntigravityStore(old).read().models, [{ id: "legacy-entry", name: "Old", levels: [] }]);
});

test("the catalog shows exactly the offered levels per Antigravity model, and chat-level writes clamp to them", () => {
	antigravityStore.update({ enabled: true, models: [
		{ id: "gemini-3-pro", name: "Gemini 3 Pro", levels: ["low", "medium", "high", "xhigh"], defaultLevel: "high" },
		{ id: "gemini-3-flash", name: "Gemini 3 Flash", levels: ["low", "medium", "high"], defaultLevel: "high" },
		{ id: "plain", name: "Plain", levels: [] },
	] });
	const dtos = modelCatalog().models.filter((m) => m.provider === "antigravity");
	assert.deepEqual(dtos.map((m) => [m.id, m.reasoning, m.supportedLevels]), [
		["gemini-3-flash", true, ["low", "medium", "high"]],
		["gemini-3-pro", true, ["low", "medium", "high", "xhigh"]],
		["plain", false, ["off"]],
	]);
	assert(dtos.every((m) => m.cost === null && m.contextWindow === null && m.maxTokens === null));
	assert.deepEqual(clampChatLevel({ model: { provider: "antigravity", id: "gemini-3-flash" }, thinkingLevel: "xhigh" }, null).thinkingLevel, "high");
	assert.equal(piModels().getModel("antigravity", "gemini-3-pro")?.reasoning, true);
});

test("a turn at \"low\": the level is set after the model and before the prompt, and confirmed", async (t) => {
	const { final, h } = await turn(t, {}, FLASH, "low");
	assert.equal(final.stopReason, "stop", final.errorMessage);
	const { sets, prompt } = wire(h);
	assert.deepEqual(sets.map((s) => [s.id, s.value]), [["model", "gemini-3-flash"], ["thought_level", "low"]]);
	assert.ok(sets[0]!.index < sets[1]!.index && sets[1]!.index < prompt, "model, then level, then prompt");
});

test("a level the current view doesn't offer is not sent; the agent's default stays and the turn goes on", async (t) => {
	const { final, h } = await turn(t, {}, FLASH, "xhigh");
	assert.equal(final.stopReason, "stop", final.errorMessage);
	assert.deepEqual(wire(h).sets.map((s) => s.id), ["model"]);
	const none = await turn(t, { models: { list: [{ value: "plain", name: "Plain", levels: [] }] } }, toPiModel({ id: "plain", name: "Plain" }), "low");
	assert.equal(none.final.stopReason, "stop");
	assert.deepEqual(wire(none.h).sets, []);
	const already = await turn(t, {}, PRO, "high");
	assert.equal(already.final.stopReason, "stop");
	assert.deepEqual(wire(already.h).sets, [], "already the current level: nothing to send");
});

test("a refused level fails the turn with the fixed message and no prompt; not signed in stays not signed in", async (t) => {
	const refused = await turn(t, { rejectLevel: true }, PRO, "low");
	assert.equal(refused.final.errorMessage, AntigravityMessage.LevelNotSet);
	assert.equal(wire(refused.h).prompt, -1);
	const signIn = await turn(t, { setConfigError: { configId: "thought_level", code: -32000, message: "Authentication required" } }, PRO, "low");
	assert.equal(signIn.final.errorMessage, AntigravityMessage.NotSignedIn);
	assert.equal(wire(signIn.h).prompt, -1);
});

test("a level answer that flips the mode to \"auto\" stops the turn before the prompt", async (t) => {
	const { final, h } = await turn(t, { levelFlipsMode: true }, PRO, "low");
	assert.equal(final.errorMessage, AntigravityMessage.ModeNotSet);
	assert.equal(wire(h).prompt, -1);
});

test("through the chat handler: a chat pinned at \"low\" sets that level on the agent before its prompt", async (t) => {
	writeSettings({ version: 1, graph: { enabled: false } });
	antigravityStore.update({ enabled: true, models: [{ id: "gemini-3-flash", name: "Gemini 3 Flash", levels: ["low", "medium", "high"], defaultLevel: "high" }] });
	const h = mockHarness(t);
	launch = h.launch;
	h.onTeardown(() => globalRuntime.shutdown());
	const chat = chatStore.createChat("Antigravity thinking");
	chatStore.saveSettings(chat.id, { model: { provider: "antigravity", id: "gemini-3-flash" }, thinkingLevel: "low" });
	assert.equal(piEngineForSpec({ provider: "antigravity", id: "gemini-3-flash", thinkingLevel: "low" }).level, "low");
	const response = await handleChatInput(chat.id, { type: "text", text: "Think a little." }, (options) => createTeacherAgent(undefined, options));
	assert.equal(response.status, 200, await response.clone().text());
	const handle = runningTurn(chat.id);
	if (handle) await new Response(handle.subscribe()).text();
	await waitFor(() => !runningTurn(chat.id), 5000, "turn settled");
	const { sets, prompt } = wire(h);
	assert.deepEqual(sets.map((s) => [s.id, s.value]), [["model", "gemini-3-flash"], ["thought_level", "low"]]);
	assert.ok(sets[1]!.index < prompt);
	globalRuntime.shutdown();
	await h.assertNoChildren();
});

test("one store read per models(), status and save (the record is not read twice)", async (t) => {
	const { antigravityHost } = await import("../src/agent/antigravity/host.ts");
	const { antigravityStatus } = await import("../src/server/antigravity.ts");
	antigravityStore.update({ enabled: true, models: [{ id: "gemini-3-pro", name: "Gemini 3 Pro", levels: ["low"] }] });
	const originalStat = fs.statSync;
	let reads = 0;
	const writable = fs as { statSync: typeof fs.statSync };
	writable.statSync = ((file: fs.PathLike, ...rest: unknown[]) => {
		if (String(file) === ANTIGRAVITY_FILE) reads++;
		return (originalStat as (...args: unknown[]) => unknown)(file, ...rest);
	}) as typeof fs.statSync;
	t.after(() => { writable.statSync = originalStat; });
	const count = (run: () => unknown) => { reads = 0; run(); return reads; };
	assert.equal(count(() => antigravityHost().models()), 1);
	assert.equal(count(() => antigravityStatus()), 1);
	assert.equal(count(() => antigravityHost().saveModels([{ id: "gemini-3-pro", name: "Gemini 3 Pro" }])), 1, "an unchanged list reads once and writes nothing");
	assert.deepEqual(antigravityStore.read().models[0]!.levels, ["low"], "the known levels were kept");
});
