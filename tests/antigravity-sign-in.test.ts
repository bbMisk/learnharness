/**
 * In-app sign-in (docs/antigravity.md): the user's Sign in click, and nothing else, sends ACP
 * `authenticate { methodId: "oauth-personal" }`; the agent itself opens its browser sign-in.
 * LearnHarness never sees a link or a token and drops the account details the answer carries.
 * Through the production path: signInAntigravity → runtime.acquire → connection.signIn → the mock.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";

import type { LaunchAgent } from "../src/agent/antigravity/binary.ts";
import { MOCK_AGY, mockHarness, waitFor, type MockHarness } from "./helpers/antigravity-mock.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-sign-in-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json") };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };

const { AntigravityRuntime, antigravityTimeouts } = await import("../src/agent/antigravity/runtime.ts");
const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-sign-in-run-"));
let launchReal: LaunchAgent | undefined;
const runtime = new AntigravityRuntime({ launch: (args, options) => (launchReal ? launchReal(args, options) : null), tempBase });
(globalThis as Record<symbol, unknown>)[Symbol.for("lh.antigravity.runtime")] = runtime;

const { antigravityStore, ANTIGRAVITY_FILE } = await import("../src/store/antigravity.ts");
const { antigravityResponse, antigravityStatus, signInAntigravity } = await import("../src/server/antigravity.ts");
const { AntigravityMessage } = await import("../src/agent/antigravity/constants.ts");

const DEFAULTS = { ...antigravityTimeouts };
after(() => {
	runtime.shutdown();
	Object.assign(antigravityTimeouts, DEFAULTS);
	process.env = originalEnv;
	globalThis.fetch = originalFetch;
	fs.rmSync(directory, { recursive: true, force: true });
	fs.rmSync(tempBase, { recursive: true, force: true });
});

process.env.LH_FORK_ANTIGRAVITY = "1";
process.env.LH_AGY_BINARY = MOCK_AGY;

function harness(t: TestContext, scenario: Record<string, unknown>): MockHarness {
	antigravityStore.update({ enabled: true, checkedAt: undefined });
	const h = mockHarness(t, { sessionClose: true, ...scenario });
	h.allowSignIn = true;
	h.onTeardown(() => runtime.shutdown());
	launchReal = h.launch;
	return h;
}
const signIns = (h: MockHarness) => h.log().filter((e) => e.kind === "authenticate") as unknown as { methodId: string }[];
const PLAN = "<account plan name>";

test("signed in already: a quick success, then the normal check; no browser; the account details go nowhere", async (t) => {
	const h = harness(t, { authenticate: "signedIn" });
	const logged: unknown[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => { logged.push(args); };
	t.after(() => { console.error = original; });
	const status = await signInAntigravity();
	assert.equal(status.problem, undefined);
	assert.ok(status.checkedAt, "the connection check ran and passed");
	assert.ok(status.models > 0);
	assert.deepEqual(signIns(h).map((e) => e.methodId), ["oauth-personal"]);
	assert.equal(h.log().some((e) => e.kind === "browser-opened"), false);
	assert.ok(!JSON.stringify(status).includes(PLAN) && !fs.readFileSync(ANTIGRAVITY_FILE, "utf8").includes(PLAN) && !JSON.stringify(logged).includes(PLAN));
	runtime.shutdown();
	await h.assertNoChildren();
});

test("signed out: the agent opens its browser sign-in; while it runs the status says so and a second press starts nothing", async (t) => {
	const h = harness(t, { authenticate: "browser", browserMs: 400 });
	const first = signInAntigravity();
	await waitFor(() => h.log().some((e) => e.kind === "browser-opened"), 5000, "the agent's browser");
	assert.equal(antigravityStatus().signingIn, true);
	const second = await signInAntigravity();
	assert.equal(second.signingIn, true, "the second press only reports the sign-in in progress");
	const done = await first;
	assert.equal(done.signingIn, undefined);
	assert.ok(done.checkedAt);
	assert.equal(signIns(h).length, 1, "one authenticate for two presses");
	runtime.shutdown();
	await h.assertNoChildren();
});

for (const [what, scenario, message] of [
	["no browser available", { authenticate: "noBrowser" }, AntigravityMessage.NotSignedIn],
	["the agent printed a sign-in link", { authenticate: "link" }, AntigravityMessage.NotSignedIn],
	["any other error", { authenticate: "error" }, "Antigravity reported an error (code -32099)."],
	["oauth-personal not offered", { authenticate: "signedIn", noOauthPersonal: true }, AntigravityMessage.SignInUnsupported],
] as const) {
	test(`sign-in fails plainly: ${what}`, async (t) => {
		const h = harness(t, scenario);
		const original = console.error;
		console.error = () => {};
		t.after(() => { console.error = original; });
		const status = await signInAntigravity();
		assert.equal(status.problem, message);
		assert.equal(status.checkedAt, undefined);
		assert.ok(!JSON.stringify(status).includes("example.invalid") && !JSON.stringify(status).includes("SECRET"), "no link reaches the status");
		if (what === "oauth-personal not offered") assert.equal(signIns(h).length, 0, "nothing sent the agent didn't offer");
		runtime.shutdown();
		await h.assertNoChildren();
	});
}

test("a sign-in not finished in time: the fixed message, and the connection is closed", async (t) => {
	antigravityTimeouts.signInMs = 300;
	t.after(() => { antigravityTimeouts.signInMs = DEFAULTS.signInMs; });
	const h = harness(t, { authenticate: "hang" });
	const status = await signInAntigravity();
	assert.equal(status.problem, "The sign-in was not finished. Try again.");
	await h.assertNoChildren(3000);
});

test("the route: POST { action: \"signIn\" } with the same protections; nothing else starts a sign-in", async () => {
	antigravityStore.update({ enabled: true });
	let signIns = 0;
	const deps = { check: async () => antigravityStatus(), status: antigravityStatus, setEnabled: () => {}, signIn: async () => { signIns++; return antigravityStatus(); } };
	const post = (body: unknown, headers: Record<string, string> = { "x-learnharness-antigravity": "1" }) => antigravityResponse(new Request("http://localhost:3000/api/antigravity", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) }), deps);
	assert.equal((await post({ action: "signIn" })).status, 200);
	assert.equal(signIns, 1);
	assert.equal((await post({ action: "signIn" }, {})).status, 403, "the intent header is required");
	assert.equal((await post({ action: "signIn", methodId: "gemini-api-key" })).status, 400, "no other method, no extra fields");
	assert.equal((await post({ action: "signOut" })).status, 400, "there is no sign-out");
	assert.equal((await post({ action: "check" })).status, 200);
	assert.equal(signIns, 1);
});

// ── review fixes: a dedicated sign-in process; the in-progress marker ──────────

test("a sign-in runs on its own short-lived agent process: a lesson streaming on the shared one is untouched by a sign-in that times out", async (t) => {
	const { createAntigravityStreamFunction } = await import("../src/agent/antigravity/stream.ts");
	const { toPiModel } = await import("../src/agent/antigravity/models.ts");
	const { normalizeContext } = await import("@earendil-works/pi-ai/utils/transcript");
	antigravityTimeouts.signInMs = 300;
	t.after(() => { antigravityTimeouts.signInMs = DEFAULTS.signInMs; });
	const h = harness(t, { authenticate: "hang", prompt: [{ text: "first " }, { sleepMs: 900 }, { text: "second" }] });
	const stream = createAntigravityStreamFunction({ runtime: () => runtime, host: () => ({ available: () => true, models: () => [], saveModels: () => {} }) });
	const events = stream(toPiModel({ id: "gemini-3-pro", name: "Gemini 3 Pro" }), normalizeContext({ systemPrompt: "Tutor", messages: [{ role: "user", content: "hi", timestamp: 0 }] }), { sessionId: "lesson-chat" });
	const reply = (async () => { for await (const _event of events) { /* drain */ } return events.result(); })();
	await waitFor(() => h.log().some((e) => e.kind === "prompt"), 5000, "the lesson's prompt");
	const status = await signInAntigravity();
	assert.equal(status.problem, "The sign-in was not finished. Try again.");
	assert.equal(h.spawns, 2, "the sign-in had its own process");
	const lesson = await reply;
	assert.equal(lesson.stopReason, "stop", lesson.errorMessage);
	assert.equal(lesson.content.map((b) => (b.type === "text" ? b.text : "")).join(""), "first second");
	assert.equal(h.children.filter((c) => c.exitCode === null && c.signalCode === null).length, 1, "only the shared process is left");
	runtime.shutdown();
	await h.assertNoChildren();
});

test("turning Antigravity off while a sign-in waits ends the sign-in process at once and stops the shared one", async (t) => {
	const h = harness(t, { authenticate: "hang" });
	const pending = signInAntigravity();
	await waitFor(() => h.log().some((e) => e.kind === "authenticate"), 5000, "the authenticate");
	const started = Date.now();
	const off = await antigravityResponse(new Request("http://localhost:3000/api/antigravity", { method: "PUT", headers: { "x-learnharness-antigravity": "1", "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) }));
	assert.equal(off.status, 200);
	const after = await pending;
	assert.ok(Date.now() - started < 3000, "not held for the sign-in limit");
	assert.equal(after.problem, undefined, "a sign-in the user turned off is not reported as a failure");
	await h.assertNoChildren(3000);
});

test("the in-progress marker: set before any work, cleared on a synchronous throw, held through the post-sign-in check, and a stale result is ignored", async () => {
	antigravityStore.update({ enabled: true, checkedAt: undefined });
	// A synchronous throw never leaves the marker stuck.
	const thrown = await signInAntigravity(() => { throw new Error("boom"); }, async () => antigravityStatus());
	assert.equal(thrown.signingIn, undefined);
	assert.equal(antigravityStatus().signingIn, undefined);
	// Held through the check: a second press during the check starts no second authenticate.
	let signIns = 0;
	let finishCheck!: () => void;
	const checking = new Promise<void>((resolve) => { finishCheck = resolve; });
	const first = signInAntigravity(async () => { signIns++; }, async () => { await checking; return antigravityStatus(); });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal((await signInAntigravity(async () => { signIns++; }, async () => antigravityStatus())).signingIn, true);
	finishCheck();
	assert.equal((await first).signingIn, undefined);
	assert.equal(signIns, 1);
	// Stale: the user turned the provider off meanwhile; the failure is not recorded.
	let fail!: (error: Error) => void;
	const stale = signInAntigravity(() => new Promise<void>((_resolve, reject) => { fail = reject; }), async () => antigravityStatus());
	await new Promise((resolve) => setTimeout(resolve, 20));
	antigravityStore.update({ enabled: false });
	await antigravityResponse(new Request("http://localhost:3000/api/antigravity", { method: "PUT", headers: { "x-learnharness-antigravity": "1", "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) }));
	fail(new Error("late"));
	assert.equal((await stale).problem, undefined);
});
