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
