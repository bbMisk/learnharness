/**
 * LearnHarness tools on Antigravity lessons (docs/antigravity.md): the agent calls the lesson's
 * declared tools through the loopback MCP bridge; LearnHarness runs them through pi. The mock
 * agent is a real MCP client of the bridge (tests/fixtures/antigravity/mock-agy.mjs), built from
 * the lead's scrubbed frames of agy 1.5.15. Every assertion reads the mock's log.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AntigravityRuntime, antigravityTimeouts } from "../src/agent/antigravity/runtime.ts";
import { ToolBridge } from "../src/agent/antigravity/tool-bridge.ts";
import { mockHarness, waitFor, type MockScenario } from "./helpers/antigravity-mock.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

const DEFAULTS = { ...antigravityTimeouts };
const ECHO = { name: "lh_echo", description: "Echo text", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } as const;

function base(t: TestContext, scenario: MockScenario = {}) {
	const h = mockHarness(t, { sessionClose: true, ...scenario });
	const tempBase = mkdtempSync(join(tmpdir(), "lh-agy-tools-"));
	const runtime = new AntigravityRuntime({ launch: h.launch, tempBase });
	h.onTeardown(() => runtime.shutdown());
	t.after(() => { Object.assign(antigravityTimeouts, DEFAULTS); rmSync(tempBase, { recursive: true, force: true }); });
	return { h, runtime };
}

test("the mock connects to the bridge during session/new like the real agent, and disconnects on session/close", async (t) => {
	const { h, runtime } = base(t);
	const bridge = await ToolBridge.start();
	t.after(() => bridge.close());
	const endpoint = await bridge.open([ECHO], { onCall: () => true, onAbort: () => {}, onInvalid: () => {} });
	const connection = await runtime.connect();
	const created = await connection.request("session/new", { cwd: connection.workspace, mcpServers: [endpoint.mcpServer] }) as { sessionId: string };
	const log = h.log();
	assert.deepEqual(log.filter((e) => e.kind === "well-known").map((e) => (e as unknown as { status: number }).status), [404, 404], "probed without the header, answered 404");
	assert.deepEqual(log.filter((e) => e.kind === "mcp-tools").map((e) => (e as unknown as { names: string[] }).names), [["lh_echo"]]);
	await connection.request("session/close", { sessionId: created.sessionId });
	await waitFor(() => h.log().some((e) => e.kind === "mcp-closed"), 3000, "the mock's MCP client to close");
});
