/**
 * Antigravity models serving the helper roles (docs/antigravity.md): every door through the
 * production code path (production gate, catalog, engine and stream; the mock agent as the only
 * stand-in), with the job's or helper's real tools reached through the MCP bridge. The network is
 * closed except loopback (the bridge); research's search provider is a stub (named below).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";

import type { LaunchAgent } from "../src/agent/antigravity/binary.ts";
import { MOCK_AGY, mockHarness, waitFor, type MockHarness } from "./helpers/antigravity-mock.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-helpers-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = {
	PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"),
	...(originalEnv.LH_ANTIGRAVITY_REUSE ? { LH_ANTIGRAVITY_REUSE: originalEnv.LH_ANTIGRAVITY_REUSE } : {}),
	// No LH_ANTIGRAVITY_TOOLS: the doors need tools; one test below checks the tools switch off.
	// No LH_ANTIGRAVITY_HELPERS: these tests are about helpers ON (the first one also checks =0).
};
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.hostname !== "127.0.0.1") throw new Error("CLOSED: unexpected network request");
	return originalFetch(input, init);
};

const { AntigravityRuntime } = await import("../src/agent/antigravity/runtime.ts");
const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-helpers-run-"));
let launchReal: LaunchAgent | undefined;
const runtime = new AntigravityRuntime({ launch: (args, options) => (launchReal ? launchReal(args, options) : null), tempBase });
(globalThis as Record<symbol, unknown>)[Symbol.for("lh.antigravity.runtime")] = runtime;

const { antigravityStore } = await import("../src/store/antigravity.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { extraction } = await import("../src/server/chat-handler.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { providerKeyMissing } = await import("../src/core/settings.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");
const { modelCatalog } = await import("../src/server/model-catalog.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { createPluginInference } = await import("../src/server/plugin-inference.ts");
const { sideTutorResponse } = await import("../src/server/side-tutor.ts");
const { ANTIGRAVITY_LESSONS_ONLY } = await import("../src/core/contracts/antigravity.ts");
const { headlessOverride } = await import("../src/agent/subagents/headless.ts");
const { createCanvas } = await import("@napi-rs/canvas");

/** Chrome is a local dependency the demo builder and visual maker check for: stubbed (renders a 1-px PNG, runs demos clean). */
function fakeHeadless() {
	const runs: string[] = [], renders: string[] = [];
	return {
		runs, renders,
		available: () => true,
		unavailableReason: () => null,
		runDemo: async (html: string) => { runs.push(html); return { consoleErrors: [], pageErrors: [], failedRequests: [], ok: true }; },
		renderSvg: async (svg: string) => { renders.push(svg); const canvas = createCanvas(1, 1); canvas.getContext("2d").fillRect(0, 0, 1, 1); return canvas.toBuffer("image/png"); },
		renderPdfPages: async () => { throw new Error("not used"); },
	};
}

after(() => {
	runtime.shutdown();
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	fs.rmSync(directory, { recursive: true, force: true });
	fs.rmSync(tempBase, { recursive: true, force: true });
});

const SPEC = { provider: "antigravity", id: "gemini-3-pro" };
process.env.LH_FORK_ANTIGRAVITY = "1";
process.env.LH_AGY_BINARY = MOCK_AGY;
antigravityStore.update({ enabled: true, models: [{ id: "gemini-3-pro", name: "Gemini 3 Pro", levels: [] }] });
// Every slot pinned to the Antigravity mock model, as a learner would in Settings → Models.
writeSettings({ version: 1, graph: { enabled: true }, models: { strong: { model: SPEC }, cheap: { model: SPEC }, vision: { model: SPEC } } } as never);

function harness(t: TestContext, scenario: Record<string, unknown>): MockHarness {
	const h = mockHarness(t, { sessionClose: true, ...scenario });
	h.onTeardown(() => runtime.shutdown());
	launchReal = h.launch;
	return h;
}
/** The tool names the mock was offered, in the order of its sessions. */
const offered = (h: MockHarness) => (h.log().filter((e) => e.kind === "mcp-tools") as unknown as { names: string[] }[]).map((e) => e.names);
const results = (h: MockHarness) => h.log().filter((e) => e.kind === "mcp-result") as unknown as { name: string; result: { content?: { type: string; text?: string }[]; isError?: boolean; error?: string } }[];
const call = (name: string, args: Record<string, unknown> = {}) => ({ mcpCall: { name, arguments: args } });

/** The production runner wiring (chat-handler's), with the production gate. */
function productionRunner(deliver: (steer: unknown) => Promise<void>, searchProvider?: () => unknown) {
	return createJobRunner({
		chatStore, jobStore, deliver: deliver as never,
		engineFor: () => piEngineForSpec(SPEC, true),
		providerKeyMissing: (provider: string, tier: "strong" | "cheap" | "vision") => (providerKeyPresent(provider) ? null : providerKeyMissing(provider, [tier])),
		...(searchProvider ? { searchProvider: searchProvider as never } : {}),
	} as never);
}

function jobChat(title: string, tool: string, toolCallId: string, input: unknown) {
	const chat = chatStore.createChat(title);
	chatStore.saveMessages(chat.id, [
		{ id: "u1", role: "user", content: "please", timestamp: 1 },
		{ id: "a1", role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: tool, arguments: input }], api: "antigravity-acp", provider: "antigravity", model: "gemini-3-pro", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1 },
		{ id: "r1", role: "toolResult", toolCallId, toolName: tool, content: [{ type: "text", text: "Dispatched." }], details: "Dispatched.", isError: false, timestamp: 1 },
	] as never);
	return chat;
}

test("the gate: an available Antigravity model serves helpers; LH_ANTIGRAVITY_HELPERS=0 refuses them as before", () => {
	assert.equal(providerKeyPresent("antigravity"), true);
	process.env.LH_ANTIGRAVITY_HELPERS = "0";
	try {
		assert.equal(providerKeyPresent("antigravity"), false);
		assert.equal(providerKeyMissing("antigravity", ["cheap"]).error, ANTIGRAVITY_LESSONS_ONLY);
	} finally { delete process.env.LH_ANTIGRAVITY_HELPERS; }
	assert.doesNotMatch(providerKeyMissing("antigravity", ["cheap"]).error, /only lessons/, "helpers on: the refusal no longer claims lessons only");
});

test("door: a PDF-reader job runs on Antigravity with its real tools; a rendered page (a following user message) rides the same agent prompt", async (t) => {
	const pdf = path.join(directory, "lesson.pdf");
	fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf"), pdf);
	const h = harness(t, { prompt: [call("pdf_info"), call("pdf_extract", { pages: "1-2" }), call("pdf_render", { pages: "1", dpi: 72 }), { text: "The integral rule appears on page 1 (p. 1): x dx integrates to x^2/2." }] });
	const chat = jobChat("Antigravity pdf job", "pdf", "call-pdf", { path: pdf, question: "What is on page 1?" });
	t.after(() => { jobStore.deleteJobsForChat(chat.id); chatStore.deleteChat(chat.id); });
	const job = jobStore.createJob({ kind: "pdf", chatId: chat.id, toolCallId: "call-pdf" });
	const steers: unknown[] = [];
	await productionRunner(async (steer) => { steers.push(steer); }).runJob(job.id);
	const done = jobStore.getJob(job.id)!;
	assert.equal(done.status, "done", JSON.stringify(done.result));
	assert.match((done.result as { brief: string }).brief, /integral rule/);
	assert.deepEqual((done.result as { pagesRead: number[] }).pagesRead, [1, 2]);
	assert.deepEqual(offered(h)[0], ["pdf_info", "pdf_extract", "pdf_render", "pdf_search"]);
	const render = results(h).find((r) => r.name === "pdf_render")!;
	assert.ok(render.result.content?.some((b) => b.type === "image"), "the rendered page reached the agent with the call's result");
	assert.equal(h.methods().filter((m) => m === "session/prompt").length, 1, "four rounds, one agent prompt");
	assert.equal(steers.length, 1);
	runtime.shutdown();
	await h.assertNoChildren();
});

test("door: a research job runs on Antigravity (search provider stubbed, no other network)", async (t) => {
	const h = harness(t, { prompt: [call("web_search", { query: "sigma.js latest version" }), { text: "## Answer\nsigma.js v3 is current ([sigma.js](https://www.sigmajs.org/))." }] });
	const chat = jobChat("Antigravity research job", "research", "call-research", { question: "Which sigma.js version?" });
	t.after(() => { jobStore.deleteJobsForChat(chat.id); chatStore.deleteChat(chat.id); });
	const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-research" });
	const queries: string[] = [];
	const search = { id: "tavily", async search(query: string) { queries.push(query); return [{ title: "sigma.js", url: "https://www.sigmajs.org/", snippet: "v3 released" }]; } };
	await productionRunner(async () => {}, () => search).runJob(job.id);
	const done = jobStore.getJob(job.id)!;
	assert.equal(done.status, "done", JSON.stringify(done.result));
	assert.match((done.result as { brief: string }).brief, /sigma\.js v3/);
	assert.deepEqual(queries, ["sigma.js latest version"]);
	assert.ok(offered(h)[0]!.includes("web_search"));
	runtime.shutdown();
	await h.assertNoChildren();
});

test("door: extraction (extractor and auditor) runs on Antigravity through the app's pipeline", async (t) => {
	const findings = { propositions: [
		{ id: "p1", name: "Derivative", statement: "The derivative measures how fast a function changes", aliases: [], messageId: "a1" },
		{ id: "p2", name: "Chain rule", statement: "The chain rule differentiates composed functions by multiplying local rates.", aliases: [], messageId: "a1" },
	], chains: [{ premises: ["p1"], conclusion: "p2" }] };
	const h = harness(t, { promptSeq: [[call("submit_findings", findings)], [call("submit_review", { links: [] })]] });
	const chat = chatStore.createChat("Antigravity extraction");
	t.after(() => chatStore.deleteChat(chat.id));
	chatStore.saveMessages(chat.id, [
		{ id: "u1", role: "user", content: "teach me the chain rule", timestamp: 1 },
		{ id: "a1", role: "assistant", content: [{ type: "text", text: "The derivative measures how fast a function changes. The chain rule differentiates composed functions by multiplying local rates." }], api: "antigravity-acp", provider: "antigravity", model: "gemini-3-pro", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
		{ id: "u2", role: "user", content: "thanks", timestamp: 3 },
	] as never);
	const started = Date.now();
	const stats = await extraction.runExtraction(chat.id);
	assert.equal(stats.nodes, 2, JSON.stringify(stats));
	assert.equal(stats.chains, 1);
	assert.deepEqual(offered(h)[0], ["submit_findings"]);
	assert.deepEqual(results(h).map((r) => r.name), ["submit_findings", "submit_review"], "both stages submitted through the bridge");
	// A submit ends the run with no further model call: the worker scope retires the parked call, so
	// each agent prompt is cancelled and its session closed at once, not after the helper wait.
	await waitFor(() => h.methods().filter((m) => m === "session/close").length === 2, 5000, "both sessions closed");
	assert.ok(Date.now() - started < 20_000);
	runtime.shutdown();
	await h.assertNoChildren();
});

test("door: plugin inference answers on Antigravity through the production catalog and gate", async (t) => {
	const h = harness(t, { prompt: [{ text: "Plugin answer." }] });
	const controller = new AbortController();
	t.after(() => controller.abort());
	const inference = createPluginInference({ signal: controller.signal, dataDirectory: path.join(directory, "plugin-data") }, { catalog: modelCatalog, providerKeyPresent, engineForSpec: piEngineForSpec });
	const answer = await inference.inference.complete({ model: SPEC, purpose: "user", context: { messages: [{ role: "user", content: "Say hi", timestamp: 0 }] } } as never);
	assert.equal(answer.stopReason, "stop", answer.errorMessage);
	assert.equal(answer.content.map((b) => (b.type === "text" ? b.text : "")).join(""), "Plugin answer.");
	runtime.shutdown();
	await h.assertNoChildren();
});

test("door: the side tutor answers on Antigravity (production engine and gate), with no session id and no tools", async (t) => {
	const h = harness(t, { prompt: [{ text: "Because the rates multiply." }] });
	const chat = chatStore.createChat("Antigravity side tutor");
	t.after(() => chatStore.deleteChat(chat.id));
	const response = await sideTutorResponse(
		new Request("http://localhost/api/chats/x/side", { method: "POST", body: JSON.stringify({ snapshot: { context: "Teacher: the chain rule multiplies rates.", truncated: false, model: SPEC }, messages: [{ role: "user", content: "Why?" }] }) }),
		chat.id,
		{ getChat: () => chatStore.getChat(chat.id), settings: () => ({ agent: {} }) as never, keyPresent: providerKeyPresent, refresh: async () => {}, engine: (spec) => piEngineForSpec(spec, false) },
	);
	assert.equal(response.status, 200, await response.clone().text());
	assert.match(await response.text(), /Because the rates multiply/);
	assert.deepEqual((h.received().find((m) => m.method === "session/new")!.params as { mcpServers: unknown[] }).mcpServers, [], "no tools, no bridge");
	runtime.shutdown();
	await h.assertNoChildren();
});

test("a job the learner aborts cancels its agent turn like Stop", async (t) => {
	const pdf = path.join(directory, "abort.pdf");
	fs.copyFileSync(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf"), pdf);
	const h = harness(t, { prompt: [{ text: "reading " }, { waitForCancel: true }] });
	const chat = jobChat("Antigravity abort", "pdf", "call-abort", { path: pdf, question: "?" });
	t.after(() => { jobStore.deleteJobsForChat(chat.id); chatStore.deleteChat(chat.id); });
	const job = jobStore.createJob({ kind: "pdf", chatId: chat.id, toolCallId: "call-abort" });
	const { abortJob } = await import("../src/server/jobs.ts");
	const running = productionRunner(async () => {}).runJob(job.id);
	await waitFor(() => h.methods().includes("session/prompt"), 5000, "the agent prompt");
	abortJob(job.id);
	await running;
	await waitFor(() => h.methods().includes("session/cancel"), 3000, "the cancel");
	assert.equal(jobStore.getJob(job.id)!.status, "error");
	runtime.shutdown();
	await h.assertNoChildren();
});

test("door: a demo job runs on Antigravity with its real tools (Chrome stubbed)", async (t) => {
	const headless = fakeHeadless();
	headlessOverride.current = headless as never;
	t.after(() => { headlessOverride.current = undefined; });
	const html = "<!doctype html><html><body><p id=\"x\">Slope demo</p></body></html>";
	const h = harness(t, { prompt: [call("write_demo", { html }), call("run_demo", {}), { text: "Notes: a single paragraph demo." }] });
	const chat = jobChat("Antigravity demo job", "demo", "call-demo", { brief: "Show the word slope." });
	t.after(() => { jobStore.deleteJobsForChat(chat.id); chatStore.deleteChat(chat.id); });
	const job = jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "call-demo" });
	await productionRunner(async () => {}).runJob(job.id);
	const done = jobStore.getJob(job.id)!;
	assert.equal(done.status, "done", JSON.stringify(done.result));
	assert.ok(headless.runs.length >= 1, "the demo was verified in the (stubbed) browser");
	assert.ok(offered(h)[0]!.includes("write_demo"));
	runtime.shutdown();
	await h.assertNoChildren();
});

test("door: a visual job runs on Antigravity: write, render, look (the render comes back as a following user message), finish", async (t) => {
	const headless = fakeHeadless();
	headlessOverride.current = headless as never;
	t.after(() => { headlessOverride.current = undefined; });
	const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"20\" viewBox=\"0 0 40 20\"><text x=\"2\" y=\"14\">slope</text></svg>";
	const h = harness(t, { prompt: [call("write_svg", { svg }), call("render_svg", {}), { text: "Notes: a labelled figure." }] });
	const chat = jobChat("Antigravity visual job", "visual", "call-visual", { brief: "The word slope." });
	t.after(() => { jobStore.deleteJobsForChat(chat.id); chatStore.deleteChat(chat.id); });
	const job = jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId: "call-visual" });
	await productionRunner(async () => {}).runJob(job.id);
	const done = jobStore.getJob(job.id)!;
	assert.equal(done.status, "done", JSON.stringify(done.result));
	assert.ok(headless.renders.length >= 1);
	const render = results(h).find((r) => r.name === "render_svg")!;
	assert.ok(render.result.content?.some((b) => b.type === "image"), "the render reached the agent with the call's result");
	runtime.shutdown();
	await h.assertNoChildren();
});

test("tools switch off: a job that needs tools refuses Antigravity with a clear message and starts nothing", async (t) => {
	const { AntigravityMessage } = await import("../src/agent/antigravity/constants.ts");
	const h = harness(t, { prompt: [{ text: "never" }] });
	process.env.LH_ANTIGRAVITY_TOOLS = "0";
	t.after(() => { delete process.env.LH_ANTIGRAVITY_TOOLS; });
	const chat = jobChat("Antigravity research, tools off", "research", "call-off", { question: "?" });
	t.after(() => { jobStore.deleteJobsForChat(chat.id); chatStore.deleteChat(chat.id); });
	const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-off" });
	await productionRunner(async () => {}, () => ({ id: "tavily", search: async () => [] })).runJob(job.id);
	const done = jobStore.getJob(job.id)!;
	assert.equal(done.status, "error");
	assert.match(JSON.stringify(done.result), new RegExp(AntigravityMessage.HelperNeedsTools.slice(0, 40)));
	assert.equal(h.spawns, 0, "the agent was never started");
});
