/**
 * The shared agy process (src/agent/antigravity/runtime.ts) against the
 * mock agent: launch, handshake, environment, sign-in signals, crashes,
 * per-session routing, idle kill and temp cleanup.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test, { type TestContext } from "node:test";

import { AcpRpcError, AcpTransportError } from "../src/agent/antigravity/acp-client.ts";
import { AntigravityMessage } from "../src/agent/antigravity/constants.ts";
import {
	agentEnv, AgentUnavailable, AntigravityRuntime, antigravityRuntime, antigravityTimeouts, describeAgentError, parseHandshake, sweepLeftovers,
	type AgentConnection, type SessionListener,
} from "../src/agent/antigravity/runtime.ts";
import { mockHarness, waitFor, type MockHarness, type MockScenario } from "./helpers/antigravity-mock.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

const FAKE_LINK = "Open the following link to authenticate the ACP server: https://example.invalid/fake-sign-in?code=SECRET";
const DEFAULTS = { ...antigravityTimeouts };

function setup(t: TestContext, scenario: MockScenario = {}, env: NodeJS.ProcessEnv = { ...process.env }) {
	const h = mockHarness(t, scenario);
	const tempBase = mkdtempSync(join(tmpdir(), "lh-agy-runtime-"));
	const runtime = new AntigravityRuntime({ launch: h.launch, tempBase, appVersion: "9.8.7", env: () => env });
	h.onTeardown(() => runtime.shutdown());
	t.after(() => {
		Object.assign(antigravityTimeouts, DEFAULTS);
		rmSync(tempBase, { recursive: true, force: true });
	});
	return { h, runtime, tempBase };
}

/** Collects one session's updates; resolves `closed` if the process dies. */
function listener() {
	const updates: Record<string, unknown>[] = [];
	let closedWith: AcpTransportError | undefined;
	const value: SessionListener = {
		onUpdate: (update) => updates.push(update),
		onPermissionRequest: () => ({ outcome: { outcome: "cancelled" } }),
		onClosed: (error) => { closedWith = error; },
	};
	return { value, updates, closed: () => closedWith, text: () => updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => (u.content as { text: string }).text).join("") };
}

async function newSession(connection: AgentConnection): Promise<string> {
	const result = await connection.request("session/new", { cwd: connection.workspace, mcpServers: [] }) as { sessionId: string };
	return result.sessionId;
}

function captureConsole(t: TestContext): string[] {
	const seen: string[] = [];
	const originals = { error: console.error, warn: console.warn, log: console.log, info: console.info };
	for (const key of Object.keys(originals) as (keyof typeof originals)[]) {
		console[key] = (...args: unknown[]) => { seen.push(args.map(String).join(" ")); };
	}
	t.after(() => Object.assign(console, originals));
	return seen;
}

test("happy path: `acp --sandbox` in an empty workspace, honest initialize, keys stripped, text streams", async (t) => {
	const env = { ...process.env, GEMINI_API_KEY: "g-key", GOOGLE_API_KEY: "go-key", gemini_api_key: "lower", LH_DESKTOP_API_SECRET: "secret", LH_DESKTOP_SERVER: "srv" };
	const { h, runtime, tempBase } = setup(t, {}, env);
	const connection = await runtime.connect();
	assert.deepEqual(connection.handshake, { agentVersion: "1.5.15", systemPromptAppend: true, sessionClose: true });

	const start = h.log()[0]!;
	assert.deepEqual(start.argv, ["acp", "--sandbox"]);
	assert.equal(realpathSync(start.cwd!), realpathSync(connection.workspace));
	assert.deepEqual(readdirSync(connection.workspace), [], "the workspace is empty");
	assert.equal(realpathSync(dirname(dirname(connection.workspace))), realpathSync(tempBase));
	for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "gemini_api_key", "LH_DESKTOP_API_SECRET", "LH_DESKTOP_SERVER"]) {
		assert(!start.envNames!.includes(name), `${name} is not passed to the agent`);
	}
	assert(start.envNames!.includes("TMPDIR"));
	assert.deepEqual(h.received()[0], {
		jsonrpc: "2.0", id: 1, method: "initialize",
		params: {
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: { name: "learnharness", title: "LearnHarness", version: "9.8.7" },
		},
	});

	const sessionId = await newSession(connection);
	const l = listener();
	const stop = connection.watch(sessionId, l.value);
	const release = connection.hold();
	assert.equal((await connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] }) as { stopReason: string }).stopReason, "end_turn");
	assert.equal(l.text(), "Hello world");
	stop(); release();
	assert(!h.methods().includes("authenticate"));

	assert.equal(await runtime.connect(), connection, "the process is shared");
	runtime.shutdown();
	await connection.closed;
	await h.assertNoChildren();
	await waitFor(() => !existsSync(dirname(connection.workspace)), 2000, "temp root removed");
});

test("agentEnv: Windows gets TEMP/TMP; every key case is stripped; nothing else changes", () => {
	assert.deepEqual(agentEnv({ A: "1", Google_Api_Key: "x" }, "/t", "linux"), { A: "1", TMPDIR: "/t" });
	assert.deepEqual(agentEnv({ A: "1", GEMINI_API_KEY: "x" }, "C:\\t", "win32"), { A: "1", TEMP: "C:\\t", TMP: "C:\\t" });
});

test("handshake: protocol 1 and 2 with v1 shapes pass; v2-only shapes and other versions fail", () => {
	assert.deepEqual(parseHandshake({ protocolVersion: 2, agentInfo: { version: "agy_acp_server_1.5.12-rc1" }, agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } }, sessionCapabilities: { close: {} } } }),
		{ agentVersion: "1.5.12", systemPromptAppend: true, sessionClose: true });
	assert.deepEqual(parseHandshake({ protocolVersion: 1, agentCapabilities: {} }), { agentVersion: null, systemPromptAppend: false, sessionClose: false });
	assert.equal(parseHandshake({ protocolVersion: 2, info: {}, capabilities: {} }), null);
	assert.equal(parseHandshake({ protocolVersion: 3, agentInfo: {}, agentCapabilities: {} }), null);
	assert.equal(parseHandshake(null), null);
});

for (const [name, scenario] of [
	["v2-only initialize shape", { shape: "v2" }],
	["protocolVersion 3", { protocolVersion: 3 }],
] as const) test(`${name} → unsupported protocol, process gone`, async (t) => {
	const { h, runtime } = setup(t, scenario);
	await assert.rejects(runtime.connect(), (error: unknown) => error instanceof AgentUnavailable && error.message === AntigravityMessage.UnsupportedProtocol);
	await h.assertNoChildren();
});

test("a non-JSON stdout line → clear error, process gone", async (t) => {
	const { h, runtime } = setup(t, { stdoutAtStart: ["Starting Antigravity (debug build)"] });
	await assert.rejects(runtime.connect(), (error: unknown) => describeAgentError(error) === AntigravityMessage.ProtocolError);
	await h.assertNoChildren();
});

test("not signed in, three ways; the link appears in no error and no log", async (t) => {
	const seen = captureConsole(t);
	const cases: MockScenario[] = [
		{ initializeError: { code: -32000, message: "Authentication required" } },
		{ initializeError: { code: -32603, message: "No browser is available here to open https://example.invalid/x" } },
		{ stdoutAtStart: [FAKE_LINK] },
		{ stderrAtStart: [FAKE_LINK] },
	];
	for (const scenario of cases) {
		const { h, runtime } = setup(t, scenario);
		const error = await runtime.connect().then(() => assert.fail("must not connect"), (e: unknown) => e);
		assert.equal(describeAgentError(error), AntigravityMessage.NotSignedIn, JSON.stringify(scenario));
		assert(!String((error as Error).message).includes("example.invalid"));
		await h.assertNoChildren();
	}
	assert(!seen.join("\n").includes("example.invalid"), "no log line carries the link");
	assert.equal(describeAgentError(new AcpRpcError(-32603, "SUBSCRIPTION_REQUIRED: tier")), AntigravityMessage.NoSubscription);
});

test("an agent error reaches the learner as a fixed sentence; its words stay in the server log", (t) => {
	const seen = captureConsole(t);
	assert.equal(describeAgentError(new AcpRpcError(-32099, "Quota detail for you@example.com, see https://example.invalid/q")), "Antigravity reported an error (code -32099).");
	assert.equal(seen.length, 1);
	assert.match(seen[0]!, /Quota detail/);
	assert(!seen[0]!.includes("example.invalid"));
	// Built by another copy of the module: classified by brand, not instanceof.
	assert.equal(describeAgentError(Object.assign(new Error("Authentication required"), { brand: "acp-rpc", code: -32000 })), AntigravityMessage.NotSignedIn);
	assert.equal(describeAgentError(Object.assign(new Error(AntigravityMessage.StartTimeout), { brand: "acp-transport", kind: "timeout" })), AntigravityMessage.StartTimeout);
	assert.equal(describeAgentError(Object.assign(new Error(AntigravityMessage.NotInstalled), { brand: "agent-unavailable" })), AntigravityMessage.NotInstalled);
});

test("stderr is never logged: an unexpected exit logs one line with its size, an exit LearnHarness asked for logs nothing", async (t) => {
	const seen = captureConsole(t);
	const crash = setup(t, { stderrAtStart: ["SECRET_STDERR token=abc"], prompt: [{ exit: 3 }] });
	const connection = await crash.runtime.connect();
	const sessionId = await newSession(connection);
	await assert.rejects(connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "x" }] }));
	await connection.closed;
	assert.equal(seen.length, 1, seen.join("\n"));
	assert.match(seen[0]!, /^Antigravity exited unexpectedly \(exit code 3, signal none\); 24 bytes of error output not shown\.$/);
	assert(!seen.join("\n").includes("SECRET"));

	seen.length = 0;
	const asked = setup(t, { stderrAtStart: ["SECRET_STDERR"] });
	const second = await asked.runtime.connect();
	await new Promise((resolve) => setTimeout(resolve, 50));
	asked.runtime.shutdown();
	await second.closed;
	assert.deepEqual(seen, []);
});

test("sign-in line with leading spaces, or with no newline at all, means not signed in", async (t) => {
	for (const scenario of [{ stdoutAtStart: [`  ${FAKE_LINK}`] }, { stdoutRawAtStart: FAKE_LINK }]) {
		const { h, runtime } = setup(t, scenario);
		await assert.rejects(runtime.connect(), (error: unknown) => describeAgentError(error) === AntigravityMessage.NotSignedIn);
		await h.assertNoChildren();
	}
});

test("killed while the initialize answer was in flight: connect rejects", async (t) => {
	const { h, runtime } = setup(t, { garbageAfterInitialize: true });
	await assert.rejects(runtime.connect(), (error: unknown) => describeAgentError(error) === AntigravityMessage.ProtocolError);
	await h.assertNoChildren();
});

test("startup timeout kills the process", async (t) => {
	antigravityTimeouts.startupMs = 100;
	const { h, runtime } = setup(t, { initializeHang: true });
	await assert.rejects(runtime.connect(), (error: unknown) => describeAgentError(error) === AntigravityMessage.StartTimeout);
	await h.assertNoChildren();
});

test("concurrent first callers share one process and one handshake", async (t) => {
	const { h, runtime } = setup(t);
	const [a, b] = await Promise.all([runtime.connect(), runtime.connect()]);
	assert.equal(a, b);
	assert.equal(h.spawns, 1);
	assert.equal(h.methods().filter((m) => m === "initialize").length, 1);
});

test("crash mid-prompt with two prompts in flight: both end, neither hangs, the next connect respawns", async (t) => {
	const { h, runtime } = setup(t, { prompt: [{ text: "partial" }, { hold: true }] });
	const connection = await runtime.connect();
	const sessions = await Promise.all([newSession(connection), newSession(connection)]);
	const listeners = sessions.map((sessionId) => { const l = listener(); connection.watch(sessionId, l.value); return l; });
	const prompts = sessions.map((sessionId) => connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "x" }] }));
	await waitFor(() => listeners.every((l) => l.text() === "partial"), 3000, "both prompts streaming");
	h.children[0]!.kill("SIGKILL");
	for (const prompt of prompts) await assert.rejects(prompt, (error: unknown) => error instanceof AcpTransportError && error.message === AntigravityMessage.Exited);
	assert(listeners.every((l) => l.closed()?.message === AntigravityMessage.Exited));
	const next = await runtime.connect();
	assert.notEqual(next, connection);
	assert.equal(h.spawns, 2);
});

test("two concurrent sessions never receive each other's chunks; unknown sessions are dropped", async (t) => {
	const { runtime } = setup(t, { prompt: [{ echo: true }, { echo: true }] });
	const connection = await runtime.connect();
	const [one, two] = await Promise.all([newSession(connection), newSession(connection)]);
	const a = listener(), b = listener();
	connection.watch(one, a.value);
	connection.watch(two, b.value);
	await Promise.all([
		connection.request("session/prompt", { sessionId: one, prompt: [{ type: "text", text: "AAA" }] }),
		connection.request("session/prompt", { sessionId: two, prompt: [{ type: "text", text: "BBB" }] }),
	]);
	assert.equal(a.text(), "echo:AAAecho:AAA");
	assert.equal(b.text(), "echo:BBBecho:BBB");
	const third = await newSession(connection); // its available_commands_update has no listener and is dropped
	assert.ok(third);
});

test("idle kill never fires while a turn holds the process, and fires after", async (t) => {
	antigravityTimeouts.idleMs = 150;
	const { h, runtime } = setup(t, { prompt: [{ sleepMs: 450 }, { text: "late" }] });
	const connection = await runtime.connect();
	const release = connection.hold();
	const sessionId = await newSession(connection);
	const prompt = connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "x" }] });
	await sleep(300);
	assert.equal(connection.alive, true, "alive mid-prompt, past the idle timeout");
	await prompt;
	await sleep(250);
	assert.equal(connection.alive, true, "still held");
	release();
	await connection.closed;
	await h.assertNoChildren();
});

test("kill escalates to SIGKILL when SIGTERM is ignored", async (t) => {
	antigravityTimeouts.killGraceMs = 150;
	const { h, runtime } = setup(t, { ignoreTerm: true });
	const connection = await runtime.connect();
	await sleep(50);
	runtime.shutdown();
	await connection.closed;
	await h.assertNoChildren();
	assert(h.log().some((entry) => entry.kind === "ignored-term"));
	assert.equal(h.children[0]!.signalCode, "SIGKILL");
});

test("no binary: connect refuses without spawning and leaves no temp root", async (t) => {
	const tempBase = mkdtempSync(join(tmpdir(), "lh-agy-runtime-"));
	t.after(() => rmSync(tempBase, { recursive: true, force: true }));
	const runtime = new AntigravityRuntime({ launch: () => null, tempBase });
	await assert.rejects(runtime.connect(), (error: unknown) => error instanceof AgentUnavailable && error.message === AntigravityMessage.NotInstalled);
	assert.deepEqual(readdirSync(tempBase), []);
});

test("sweep removes roots of exited server processes only", (t) => {
	const base = mkdtempSync(join(tmpdir(), "lh-agy-sweep-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const dead = join(base, "run-999999999-abc"), mine = join(base, `run-${process.pid}-def`), parent = join(base, `run-${process.ppid}-ghi`), other = join(base, "unrelated");
	for (const dir of [dead, mine, parent, other]) mkdirSync(join(dir, "tmp"), { recursive: true });
	sweepLeftovers(base);
	assert.equal(existsSync(dead), false);
	assert.equal(existsSync(mine), true);
	assert.equal(existsSync(parent), true);
	assert.equal(existsSync(other), true);
});

test("the process-wide runtime is one shared instance", () => {
	assert.equal(antigravityRuntime(), antigravityRuntime());
	assert.equal(antigravityRuntime().connection, undefined, "nothing starts until a turn or a check asks");
});
