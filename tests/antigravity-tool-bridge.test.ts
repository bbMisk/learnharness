/**
 * The loopback MCP bridge for Antigravity sessions (src/agent/antigravity/tool-bridge.ts),
 * driven by the MCP SDK's own client, the way the agent connects to it.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { MAX_BRIDGE_BODY_BYTES, ToolBridge, type HeldCall, type McpServerEntry } from "../src/agent/antigravity/tool-bridge.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

const ECHO: Tool = { name: "lh_echo", description: "Echo text", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
const result = (content: ToolResultMessage["content"], isError = false): ToolResultMessage => ({ role: "toolResult", toolCallId: "x", toolName: "lh_echo", content, isError, timestamp: 0 });

async function bridgeFor(t: TestContext) {
	const bridge = await ToolBridge.start();
	t.after(() => bridge.close());
	const calls: HeldCall[] = [];
	const aborted: HeldCall[] = [];
	const invalid: string[] = [];
	const endpoint = await bridge.open([ECHO], { onCall: (call) => { calls.push(call); return true; }, onAbort: (call) => aborted.push(call), onInvalid: (reason) => invalid.push(reason) });
	return { bridge, endpoint, calls, aborted, invalid };
}

async function client(t: TestContext, entry: McpServerEntry, authorization = entry.headers[0]!.value) {
	const c = new Client({ name: "test-agent", version: "1.0.0" });
	await c.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: { Authorization: authorization } } }));
	t.after(() => c.close());
	return c;
}

const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(check()); };

test("lists exactly the declared tools; a call is held until LearnHarness answers it (text and image)", async (t) => {
	const { endpoint, calls } = await bridgeFor(t);
	const c = await client(t, endpoint.mcpServer);
	assert.deepEqual((await c.listTools()).tools.map((tool) => [tool.name, tool.inputSchema]), [["lh_echo", ECHO.parameters]]);
	const pending = c.callTool({ name: "lh_echo", arguments: { text: "hello" } });
	await until(() => calls.length === 1);
	assert.deepEqual([calls[0]!.name, calls[0]!.arguments], ["lh_echo", { text: "hello" }]);
	assert.equal(endpoint.resolve(calls[0]!.id, result([{ type: "text", text: "echo:hello" }, { type: "image", data: "AAAA", mimeType: "image/png" }])), true);
	assert.deepEqual(await pending, { content: [{ type: "text", text: "echo:hello" }, { type: "image", data: "AAAA", mimeType: "image/png" }], isError: false });
	assert.equal(endpoint.resolve(calls[0]!.id, result([])), false, "answered once");
});

test("a wrong token answers 401, a wrong path or the well-known probes 404, with no call", async (t) => {
	const { endpoint, calls } = await bridgeFor(t);
	const url = new URL(endpoint.mcpServer.url);
	const post = (target: URL, headers: Record<string, string>) => fetch(target, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
	assert.equal((await post(url, { Authorization: "Bearer nope" })).status, 401);
	assert.equal((await post(url, {})).status, 401);
	assert.equal((await post(new URL(`/mcp/${"0".repeat(64)}`, url), { Authorization: endpoint.mcpServer.headers[0]!.value })).status, 404);
	for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
		const res = await fetch(new URL(path, url));
		assert.equal(res.status, 404);
		assert.equal(await res.text(), "");
	}
	assert.equal(calls.length, 0);
});

test("an undeclared tool is refused and reported; an abort by the agent is reported; close fails held calls", async (t) => {
	const { endpoint, calls, aborted, invalid } = await bridgeFor(t);
	const c = await client(t, endpoint.mcpServer);
	await assert.rejects(c.callTool({ name: "run_command", arguments: {} }));
	assert.deepEqual(invalid, ["undeclared tool"]);
	const controller = new AbortController();
	const cancelled = c.callTool({ name: "lh_echo", arguments: { text: "a" } }, undefined, { signal: controller.signal });
	await until(() => calls.length === 1);
	controller.abort();
	await assert.rejects(cancelled);
	await until(() => aborted.length === 1);
	assert.equal(aborted[0]!.id, calls[0]!.id);
	const held = c.callTool({ name: "lh_echo", arguments: { text: "b" } });
	await until(() => calls.length === 2);
	await endpoint.close();
	const closed = await held.catch((error: unknown) => error);
	assert.ok(closed instanceof Error || (closed as { isError?: boolean }).isError === true, "the held call ends when its session closes");
	assert.equal(endpoint.resolve(calls[1]!.id, result([])), false);
});

test("a refused call (onCall false) is answered with an error at once", async (t) => {
	const bridge = await ToolBridge.start();
	t.after(() => bridge.close());
	const endpoint = await bridge.open([ECHO], { onCall: () => false, onAbort: () => {}, onInvalid: () => {} });
	const c = await client(t, endpoint.mcpServer);
	assert.equal((await c.callTool({ name: "lh_echo", arguments: { text: "a" } })).isError, true);
});

test("a body over 8 MiB is refused with 413", async (t) => {
	const { endpoint } = await bridgeFor(t);
	const res = await fetch(endpoint.mcpServer.url, { method: "POST", headers: { Authorization: endpoint.mcpServer.headers[0]!.value, "Content-Type": "application/json" }, body: "x".repeat(MAX_BRIDGE_BODY_BYTES + 1) });
	assert.equal(res.status, 413);
});

test("each session has its own endpoint and token", async (t) => {
	const { bridge, endpoint } = await bridgeFor(t);
	const other = await bridge.open([ECHO], { onCall: () => true, onAbort: () => {}, onInvalid: () => {} });
	assert.notEqual(other.mcpServer.url, endpoint.mcpServer.url);
	const res = await fetch(other.mcpServer.url, { method: "POST", headers: { Authorization: endpoint.mcpServer.headers[0]!.value, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
	assert.equal(res.status, 401, "one session's token does not open another's endpoint");
	assert.equal(bridge.size, 2);
	await other.close();
	assert.equal(bridge.size, 1);
});
