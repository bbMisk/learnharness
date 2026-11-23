/**
 * Antigravity's doors (docs/antigravity.md): off twice by default, a lesson
 * turn admitted end to end through chat-handler on the mock agent, and every
 * helper door refused without a spawn. Model discovery and persistence.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

import type { LaunchAgent } from "../src/agent/antigravity/binary.ts";
import { MOCK_AGY, mockHarness, waitFor } from "./helpers/antigravity-mock.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

// Isolation first: no ambient keys, data, network. Every import that reads them follows.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-gates-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json") };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };

const { AntigravityRuntime } = await import("../src/agent/antigravity/runtime.ts");
const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-gates-run-"));
// The process-wide runtime, replaced by one whose launcher is a spy.
let launches = 0;
let launchReal: LaunchAgent | undefined;
const spyRuntime = new AntigravityRuntime({ launch: (args, options) => { launches++; return launchReal ? launchReal(args, options) : null; }, tempBase });
(globalThis as Record<symbol, unknown>)[Symbol.for("lh.antigravity.runtime")] = spyRuntime;

const { piModels, piEngineForSpec } = await import("../src/agent/models.ts");
const { modelCatalog, validateModelsSettings, validateChatSettings, toModelDto } = await import("../src/server/model-catalog.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { providerKeyMissing, isProviderKeyRefusal, ProviderKeyMissingError } = await import("../src/core/settings.ts");
const { antigravityResponse, antigravityTurnRefusal, checkAntigravityConnection } = await import("../src/server/antigravity.ts");
const { antigravityAvailable } = await import("../src/server/antigravity-config.ts");
const { antigravityStore, ANTIGRAVITY_FILE, createAntigravityStore } = await import("../src/store/antigravity.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { handleChatInput, extraction } = await import("../src/server/chat-handler.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { automaticFollowUpAllowed } = await import("../src/server/jobs.ts");
const { sideTutorResponse } = await import("../src/server/side-tutor.ts");
const { createPluginInference } = await import("../src/server/plugin-inference.ts");
const { callCost } = await import("../src/server/pricing.ts");
const { connectionBackgroundAllowed } = await import("../src/agent/subscription-connections.ts");
const { needsSendToUser } = await import("../src/agent/tools/send-to-user.ts");
const { checkAntigravityAgent } = await import("../src/agent/antigravity/provider.ts");
const { modelsFrom } = await import("../src/agent/antigravity/models.ts");
const { runSubagent } = await import("../src/agent/subagents/pi-run.ts");
const { authStore } = await import("../src/store/auth.ts");
const { authEnvRecord, externalCliEnv } = await import("../src/core/auth-env.ts");
const { ANTIGRAVITY_LESSONS_ONLY, ANTIGRAVITY_UNAVAILABLE } = await import("../src/core/contracts/antigravity.ts");

after(() => {
	spyRuntime.shutdown();
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	fs.rmSync(directory, { recursive: true, force: true });
	fs.rmSync(tempBase, { recursive: true, force: true });
});

const PRO = { id: "gemini-3-pro", name: "Gemini 3 Pro" };
const SPEC = { provider: "antigravity", id: "gemini-3-pro" };

function state({ switchOn, enabled, installed }: { switchOn: boolean; enabled: boolean; installed: boolean }) {
	if (switchOn) process.env.LH_FORK_ANTIGRAVITY = "1"; else delete process.env.LH_FORK_ANTIGRAVITY;
	if (installed) process.env.LH_AGY_BINARY = MOCK_AGY; else delete process.env.LH_AGY_BINARY;
	antigravityStore.update({ enabled, models: [PRO] });
}

function request(method: string, body?: unknown) {
	return new Request("http://localhost:3000/api/antigravity", {
		method, headers: { "x-learnharness-antigravity": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
}

function lessonChat(title: string) {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, { model: SPEC });
	return chat;
}

const build = (options: Parameters<typeof createTeacherAgent>[1]) => createTeacherAgent(undefined, options);

beforeEach(() => {
	launchReal = undefined;
	writeSettings({ version: 1, graph: { enabled: false } });
});

for (const [label, setup] of [
	["switch off (even opted in, installed, with saved models)", { switchOn: false, enabled: true, installed: true }],
	["switch on but not opted in", { switchOn: true, enabled: false, installed: true }],
	["switch on, opted in, no binary", { switchOn: true, enabled: true, installed: false }],
] as const) test(`${label}: no models, admission refuses, nothing spawns`, async () => {
	state(setup);
	const before = launches;
	assert.equal(antigravityAvailable(), false);
	assert(!modelCatalog().models.some((m) => m.provider === "antigravity"));
	assert.deepEqual(piModels().getModels("antigravity"), []);
	assert.equal(modelCatalog().providers.some((p) => p.id === "antigravity"), setup.switchOn, "a provider row only while the switch is on");
	assert.equal(modelCatalog().providers.find((p) => p.id === "antigravity")?.keyPresent ?? false, false);
	assert.equal(validateModelsSettings({ strong: { model: SPEC } }).ok, false);
	assert.equal(validateChatSettings({ model: SPEC }).ok, false);
	assert.equal(providerKeyPresent("antigravity"), false);
	assert.throws(() => piEngineForSpec(SPEC), /catalog has no model/);

	const chat = lessonChat(`Antigravity ${label}`);
	const response = await handleChatInput(chat.id, { type: "text", text: "hi" }, build);
	assert.equal(response.status, 503);
	assert.equal((await response.json()).error, ANTIGRAVITY_UNAVAILABLE);
	assert.equal(chatStore.getChat(chat.id)!.messages.length, 0, "nothing was written");

	const status = await antigravityResponse(request("GET"));
	if (!setup.switchOn) {
		assert.equal(status.status, 200);
		assert.deepEqual(await status.json(), { available: false }, "nothing but the switch state");
		assert.equal((await antigravityResponse(request("PUT", { enabled: true }))).status, 404);
		assert.equal((await antigravityResponse(request("POST", { action: "check" }))).status, 404);
	} else {
		assert.equal(status.status, 200);
		assert.deepEqual(await status.json(), { available: true, enabled: setup.enabled, installed: setup.installed, models: 1 });
	}
	if (setup.switchOn && !setup.enabled) assert.equal((await antigravityResponse(request("POST", { action: "check" }))).status, 403);
	assert.equal(launches, before, "no spawn");
});

test("available: models from the saved list, picker accepts them, a lesson turn runs end to end on the mock", async (t) => {
	state({ switchOn: true, enabled: true, installed: true });
	const h = mockHarness(t);
	h.onTeardown(() => spyRuntime.shutdown());
	launchReal = h.launch;
	assert.equal(antigravityAvailable(), true);
	const dto = modelCatalog().models.find((m) => m.provider === "antigravity");
	assert.deepEqual(dto, { id: "gemini-3-pro", name: "Gemini 3 Pro", provider: "antigravity", reasoning: false, input: ["text"], supportedLevels: ["off"], cost: null, contextWindow: null, maxTokens: null });
	assert.deepEqual(toModelDto(piModels().getModel("antigravity", "gemini-3-pro")!).cost, null);
	assert.equal(modelCatalog().providers.find((p) => p.id === "antigravity")?.keyPresent, true);
	assert.equal(validateChatSettings({ model: SPEC }).ok, true);
	assert.equal(callCost({ inputTokens: 10, outputTokens: 10 }, "antigravity:gemini-3-pro"), null, "unpriced");

	const chat = lessonChat("Antigravity lesson");
	const response = await handleChatInput(chat.id, { type: "text", text: "Teach me fractions" }, build);
	assert.equal(response.status, 200, await response.clone().text());
	const handle = runningTurn(chat.id);
	if (handle) await new Response(handle.subscribe()).text();
	await waitFor(() => !runningTurn(chat.id), 5000, "turn settled");
	const saved = chatStore.getChat(chat.id)!.messages;
	const reply = saved.findLast((message) => (message as { role?: string }).role === "assistant") as { content: { type: string; text?: string }[]; provider: string } | undefined;
	assert.equal(reply?.provider, "antigravity");
	assert.equal(reply?.content.filter((block) => block.type === "text").map((block) => block.text).join(""), "Hello world");
	assert.equal(launches > 0, true);
	assert.deepEqual(h.methods().filter((m) => m !== "session/close"), ["initialize", "session/new", "session/set_config_option", "session/prompt"]);
	const prompt = h.received().find((m) => m.method === "session/prompt")!.params as { prompt: { text: string }[] };
	assert.match(prompt.prompt.at(-1)!.text, /Teach me fractions/);
	assert(!JSON.stringify(prompt).includes("send_to_user"), "no tool channel is offered");

	// The helper doors still refuse while the lesson door is open.
	assert.equal(providerKeyPresent("antigravity"), false);
	assert.equal(automaticFollowUpAllowed(chat.id), false, "wake pipeline: no automatic follow-up");
	const steers = antigravityTurnRefusal("steers", []);
	assert.equal(steers?.status, 403);
	assert.equal(antigravityTurnRefusal("text", []), null);
	assert.equal(connectionBackgroundAllowed("antigravity"), true, "the chat's own compaction is allowed (its stream re-checks availability)");
	spyRuntime.shutdown();
	await h.assertNoChildren();
});

test("denied doors refuse before any spawn: jobs, extraction envelope, side tutor, plugin inference", async (t) => {
	state({ switchOn: true, enabled: true, installed: true });
	const harness = mockHarness(t);
	harness.onTeardown(() => spyRuntime.shutdown());
	launchReal = harness.launch;
	const before = launches;

	// Background jobs (and the extraction pipeline, which shares this refusal closure in chat-handler).
	const chat = lessonChat("Antigravity job fixture");
	t.after(() => { jobStore.deleteJobsForChat(chat.id); chatStore.deleteChat(chat.id); });
	const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "agy-job" });
	let calls = 0;
	const runner = createJobRunner({ chatStore, jobStore, deliver: async () => {},
		engineFor: () => { const engine = piEngineForSpec(SPEC); return { ...engine, streamFn: (...args) => { calls++; return engine.streamFn(...args); } }; },
		providerKeyMissing: (provider, tier) => providerKeyPresent(provider) ? null : providerKeyMissing(provider, [tier]),
	});
	await runner.runJob(job.id, { question: "Synthetic fixture only" });
	assert.equal(calls, 0);
	assert.equal(jobStore.getJob(job.id)!.status, "error");
	assert.match(JSON.stringify(jobStore.getJob(job.id)!.result), /Antigravity runs only lessons you start/);
	assert.equal(providerKeyMissing("antigravity", ["cheap"]).error, ANTIGRAVITY_LESSONS_ONLY);
	assert.equal(isProviderKeyRefusal(ANTIGRAVITY_LESSONS_ONLY), true);

	// Side tutor, with production's key check.
	const side = await sideTutorResponse(
		new Request("http://localhost/api/chats/x/side", { method: "POST", body: JSON.stringify({ snapshot: { context: "Teacher: hi.", truncated: false, model: SPEC }, messages: [{ role: "user", content: "Why?" }] }) }),
		chat.id,
		{ getChat: () => chatStore.getChat(chat.id), settings: () => ({}) as never, keyPresent: providerKeyPresent, refresh: async () => {}, engine: () => assert.fail("side tutor must not build an Antigravity engine") },
	);
	assert.notEqual(side.status, 200);

	// Plugin inference, with production's catalog and key check.
	const controller = new AbortController();
	t.after(() => controller.abort());
	const inference = createPluginInference({ signal: controller.signal, dataDirectory: path.join(directory, "plugin-data") }, { catalog: modelCatalog, providerKeyPresent, engineForSpec: piEngineForSpec });
	await assert.rejects(inference.engineFor(SPEC, "user"), /Antigravity runs only lessons you start/);

	// The wake pipeline's steers, through the real chat handler.
	const steered = await handleChatInput(chat.id, { type: "steers", steers: [] }, build);
	assert.equal(steered.status, 403);
	assert.match((await steered.json()).error, /Automatic follow-ups stay queued/);

	// The production extraction pipeline with its cheap tier pinned to Antigravity.
	writeSettings({ version: 1, graph: { enabled: false }, models: { cheap: { model: SPEC }, strong: { model: SPEC } } });
	await assert.rejects(extraction.runExtraction(chat.id), (error: unknown) => error instanceof ProviderKeyMissingError && error.message === ANTIGRAVITY_LESSONS_ONLY);

	// A continue with no learner cause never reaches a turn.
	assert.equal(antigravityTurnRefusal("continue", [])?.status, 403, "a continue with no learner cause is refused");
	assert.equal(needsSendToUser({ provider: "antigravity", id: "claude-sonnet-4-5" }), false);
	assert.equal(launches, before, "no spawn");
});

test("check connection: flat, grouped and legacy model lists are persisted and survive a restart", async (t) => {
	state({ switchOn: true, enabled: true, installed: true });
	for (const style of ["flat", "grouped", "legacy"]) {
		const h = mockHarness(t, { models: { style, list: [{ value: `${style}-a`, name: `${style} A` }, { value: `${style}-b`, name: `${style} B` }] } });
		const runtime = new AntigravityRuntime({ launch: h.launch, tempBase });
		h.onTeardown(() => runtime.shutdown());
		const status = await checkAntigravityConnection(() => checkAntigravityAgent(runtime));
		assert.equal(status.models, 2, style);
		assert.equal(status.agentVersion, "1.5.12");
		assert.ok(status.checkedAt && !status.problem);
		assert(!h.methods().includes("session/prompt"), "a check sends no prompt");
		runtime.shutdown();
		await h.assertNoChildren();
		// A restart: a fresh store over the same file, and the provider reads it.
		const restarted = createAntigravityStore(ANTIGRAVITY_FILE).read();
		assert.deepEqual(restarted.models, [{ id: `${style}-a`, name: `${style} A` }, { id: `${style}-b`, name: `${style} B` }]);
		assert.deepEqual(piModels().getModels("antigravity").map((m) => m.id), [`${style}-a`, `${style}-b`]);
	}
	const file = JSON.parse(fs.readFileSync(ANTIGRAVITY_FILE, "utf8"));
	assert.deepEqual(Object.keys(file).sort(), ["agentVersion", "checkedAt", "enabled", "models", "version"]);
});

test("check connection when not signed in: the status says so and keeps the old list", async (t) => {
	state({ switchOn: true, enabled: true, installed: true });
	const h = mockHarness(t, { initializeError: { code: -32000, message: "Authentication required" } });
	const runtime = new AntigravityRuntime({ launch: h.launch, tempBase });
	h.onTeardown(() => runtime.shutdown());
	const status = await checkAntigravityConnection(() => checkAntigravityAgent(runtime));
	assert.match(status.problem ?? "", /Not signed in to Antigravity/);
	assert.equal(status.models, 1);
	await h.assertNoChildren();
	const put = await antigravityResponse(request("PUT", { enabled: false }));
	const off = await put.json() as { enabled: boolean; problem?: string };
	assert.equal(off.enabled, false);
	assert.equal(off.problem, undefined, "turning it off clears the problem");
});

test("a failed check is persisted: no stale \"Connected\" after a restart, the model list kept", async (t) => {
	state({ switchOn: true, enabled: true, installed: true });
	const ok = mockHarness(t);
	const good = new AntigravityRuntime({ launch: ok.launch, tempBase });
	ok.onTeardown(() => good.shutdown());
	assert.ok((await checkAntigravityConnection(() => checkAntigravityAgent(good))).checkedAt);
	good.shutdown();
	const bad = mockHarness(t, { sessionNewError: { code: -32000, message: "Authentication required" } });
	const failing = new AntigravityRuntime({ launch: bad.launch, tempBase });
	bad.onTeardown(() => failing.shutdown());
	const status = await checkAntigravityConnection(() => checkAntigravityAgent(failing));
	assert.equal(status.checkedAt, undefined);
	assert.match(status.problem ?? "", /Not signed in/);
	const restarted = createAntigravityStore(ANTIGRAVITY_FILE).read();
	assert.equal(restarted.checkedAt, undefined, "a restart shows \"not checked\", not Connected");
	assert.equal(restarted.models.length, 2, "pinned lessons still resolve");
});

test("model lists drop entries with a link, a control character or more than 200 characters, and never store them", () => {
	const listed = modelsFrom({ configOptions: [{ id: "model", category: "model", currentValue: "ok", options: [
		{ value: "ok", name: "Fine" },
		{ value: "https://evil.example/m", name: "Link id" },
		{ value: "named", name: "Visit https://evil.example" },
		{ value: "bell\u0007", name: "Bell" },
		{ value: "x".repeat(201), name: "Long" },
		{ value: "nl", name: "two\nlines" },
		{ group: "g", options: [{ value: "grouped-ok" }] },
	] }] });
	assert.deepEqual(listed, [{ id: "ok", name: "Fine" }, { id: "grouped-ok", name: "grouped-ok" }]);
	assert.deepEqual(modelsFrom({ models: { availableModels: [{ modelId: "fine" }, { modelId: "bad", name: "see ftp://x" }] } }), [{ id: "fine", name: "fine" }]);
	const file = path.join(directory, "unsafe-models.json");
	fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: true, models: [{ id: "ok", name: "Fine" }, { id: "https://evil.example", name: "x" }, { id: "y", name: "\u001b[31mred" }] }));
	assert.deepEqual(createAntigravityStore(file).read().models, [{ id: "ok", name: "Fine" }]);
	createAntigravityStore(file).update({ models: [{ id: "a://b", name: "x" }, { id: "kept", name: "Kept" }] });
	assert(!fs.readFileSync(file, "utf8").includes("a://b"), "never persisted");
});

test("the lesson door is an allowlist of learner inputs; everything else is refused", () => {
	state({ switchOn: true, enabled: true, installed: true });
	for (const type of ["text", "answer", "retry", "retry-question", "thinking", "next", "plugin-question-answer", "plugin-problem-submission"]) {
		assert.equal(antigravityTurnRefusal(type, []), null, type);
	}
	for (const type of ["steers", "continue", "dismiss", "dismiss-plugin-question", "bogus", "", "toString", "__proto__"]) {
		assert.equal(antigravityTurnRefusal(type, [])?.status, 403, JSON.stringify(type));
	}
});

test("the lesson door refreshes key provenance first, so a file-only key never reaches the agent", (t) => {
	state({ switchOn: true, enabled: true, installed: true });
	t.after(() => { authStore.deleteAuthVar("OPENAI_API_KEY"); delete process.env.OPENAI_API_KEY; authEnvRecord().fillGap.delete("OPENAI_API_KEY"); });
	authStore.setAuthVar("OPENAI_API_KEY", "sk-file-only-fixture");
	assert.equal(process.env.OPENAI_API_KEY, undefined);
	assert.equal(antigravityTurnRefusal("text", []), null);
	assert.equal(authEnvRecord().fillGap.has("OPENAI_API_KEY"), true, "initAuthEnv ran on the admit path");
	assert.equal(externalCliEnv().OPENAI_API_KEY, undefined, "and the agent's environment leaves it out");
});

test("a foreground continue with real saved history is ALLOWED: it resumes the reply the learner is owed", async (t) => {
	state({ switchOn: true, enabled: true, installed: true });
	const h = mockHarness(t);
	h.onTeardown(() => spyRuntime.shutdown());
	launchReal = h.launch;
	const chat = lessonChat("Antigravity owed reply");
	chatStore.saveMessages(chat.id, [{ role: "user", id: "learner-1", content: "Explain fractions", timestamp: Date.now() } as never]);
	const response = await handleChatInput(chat.id, { type: "continue" }, build);
	assert.equal(response.status, 200, await response.clone().text());
	const handle = runningTurn(chat.id);
	if (handle) await new Response(handle.subscribe()).text();
	await waitFor(() => !runningTurn(chat.id), 5000, "turn settled");
	const reply = chatStore.getChat(chat.id)!.messages.findLast((m) => (m as { role?: string }).role === "assistant") as { content: { type: string; text?: string }[] } | undefined;
	assert.equal(reply?.content.map((b) => b.text ?? "").join(""), "Hello world");
	assert.match(JSON.stringify(h.received().find((m) => m.method === "session/prompt")), /Explain fractions/);
	spyRuntime.shutdown();
	await h.assertNoChildren();
});

test("a continue whose last cause is automatic (a job result) is refused before any spawn", async () => {
	state({ switchOn: true, enabled: true, installed: true });
	const before = launches;
	const chat = lessonChat("Antigravity automatic continue");
	chatStore.saveMessages(chat.id, [
		{ role: "user", id: "learner-1", content: "Research fractions", timestamp: 1 },
		{ role: "assistant", id: "reply-1", content: [{ type: "text", text: "Started a job." }], api: "antigravity-acp", provider: "antigravity", model: "gemini-3-pro", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
		{ role: "custom", id: "steer-1", customType: "subagent-steer", content: "Job finished.", display: false, timestamp: 3 },
	] as never);
	const response = await handleChatInput(chat.id, { type: "continue" }, build);
	assert.equal(response.status, 403);
	assert.equal(launches, before);
});

test("the stream as the chat's compaction summarizer calls it (runSubagent, no tools, one turn)", async (t) => {
	// Production ensureCompacted returns early under NODE_ENV=test unless a summarizer is injected
	// (src/server/compaction.ts:345), so this drives the same call subagentSummarizer makes, with the
	// chat's compaction engine (piEngineForSpec(spec, true)), rather than ensureCompacted itself.
	state({ switchOn: true, enabled: true, installed: true });
	const h = mockHarness(t, { prompt: [{ text: "Summary: fractions." }] });
	h.onTeardown(() => spyRuntime.shutdown());
	launchReal = h.launch;
	const { text } = await runSubagent([], { role: "researcher" as never, prompt: "Summarize the span.", engine: piEngineForSpec(SPEC, true), systemPrompt: "You are the session-compaction summarizer.", bypassWorkerRequestAdmission: true });
	assert.equal(text, "Summary: fractions.");
	const prompt = h.received().find((m) => m.method === "session/prompt")!.params as { prompt: { text: string }[] };
	assert.match(JSON.stringify(prompt), /Summarize the span/);
	spyRuntime.shutdown();
	await h.assertNoChildren();
});

test("store: only `enabled: true` opts in; garbage is sanitized", () => {
	const file = path.join(directory, "sanitize.json");
	fs.writeFileSync(file, JSON.stringify({ version: 1, enabled: "true", models: [{ id: "a" }, { id: "a" }, { id: 3 }, null], agentVersion: "1.5", checkedAt: "never" }));
	assert.deepEqual(createAntigravityStore(file).read(), { version: 1, enabled: false, models: [{ id: "a", name: "a" }] });
	fs.writeFileSync(file, "{not json");
	assert.deepEqual(createAntigravityStore(file).read(), { version: 1, enabled: false, models: [] });
});

test("route protections: cross-site, foreign origin and missing header are refused; bad bodies are 400", async () => {
	state({ switchOn: true, enabled: false, installed: true });
	for (const headers of [{ origin: "https://attacker.invalid" }, { "sec-fetch-site": "cross-site" }, { "x-learnharness-antigravity": "" }] as Record<string, string>[]) {
		const response = await antigravityResponse(new Request("http://localhost:3000/api/antigravity", { headers: { "x-learnharness-antigravity": "1", ...headers } }));
		assert.equal(response.status, 403, JSON.stringify(headers));
	}
	for (const body of [{ enabled: "yes" }, { enabled: true, extra: 1 }, []]) assert.equal((await antigravityResponse(request("PUT", body))).status, 400);
	assert.equal((await antigravityResponse(request("POST", { action: "go" }))).status, 400);
	assert.equal((await antigravityResponse(request("DELETE"))).status, 405);
	assert.equal(antigravityStore.read().enabled, false);
	const on = await antigravityResponse(request("PUT", { enabled: true }));
	assert.equal((await on.json()).enabled, true);
});
