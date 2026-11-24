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

/** Initialize over raw HTTP (no SDK client), like an agent that manages its own requests. */
async function rawSession(entry: McpServerEntry) {
	const headers = { Authorization: entry.headers[0]!.value, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
	const init = await fetch(entry.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } }) });
	const session = init.headers.get("mcp-session-id")!;
	await init.text();
	const withSession = { ...headers, "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" };
	await (await fetch(entry.url, { method: "POST", headers: withSession, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).text();
	return (body: unknown, signal?: AbortSignal) => fetch(entry.url, { method: "POST", headers: withSession, body: JSON.stringify(body), signal });
}

test("the agent dropping the HTTP request of a held call (no MCP cancel notification) is reported as an abort", async (t) => {
	const { endpoint, calls, aborted } = await bridgeFor(t);
	const post = await rawSession(endpoint.mcpServer);
	const controller = new AbortController();
	const pending = post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lh_echo", arguments: { text: "a" } } }, controller.signal).then((res) => res.text()).catch(() => "aborted");
	await until(() => calls.length === 1);
	controller.abort();
	assert.equal(await pending, "aborted");
	await until(() => aborted.length === 1);
	assert.equal(aborted[0]!.id, calls[0]!.id);
	assert.equal(endpoint.resolve(calls[0]!.id, result([])), false, "an aborted call can no longer be answered");
});

test("tools/call with arguments that are not an object is refused and reported", async (t) => {
	const { endpoint, calls, invalid } = await bridgeFor(t);
	const post = await rawSession(endpoint.mcpServer);
	for (const [id, args] of [[2, "text"], [3, [1, 2]], [4, 5]] as const) {
		const text = await (await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "lh_echo", arguments: args } })).text();
		assert.match(text, /error/i);
	}
	assert.equal(calls.length, 0);
	assert.equal(invalid.length, 3, "each malformed call is reported");
});


// ── review fixes: no lost answers, fail closed ──────────────────────────────

test("a tools/call whose request is already dead when the handler runs is never handed to the turn", async (t) => {
	const { toolBridgeTestHooks } = await import("../src/agent/antigravity/tool-bridge.ts");
	t.after(() => { delete toolBridgeTestHooks.beforeDispatch; });
	const { endpoint, calls } = await bridgeFor(t);
	const post = await rawSession(endpoint.mcpServer);
	toolBridgeTestHooks.beforeDispatch = (res) => { res.destroy(); };
	await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lh_echo", arguments: { text: "a" } } }).then((r) => r.text(), () => "dropped");
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(calls.length, 0, "a dead request holds nothing");
});

test("held requests are keyed internally: a second request reusing a JSON-RPC id is refused and cannot abort or steal the first", async (t) => {
	const { toolBridgeTestHooks } = await import("../src/agent/antigravity/tool-bridge.ts");
	t.after(() => { delete toolBridgeTestHooks.beforeDispatch; });
	const { endpoint, calls, aborted, invalid } = await bridgeFor(t);
	const post = await rawSession(endpoint.mcpServer);
	const first = post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "lh_echo", arguments: { text: "first" } } }).then((r) => r.text());
	await until(() => calls.length === 1);
	toolBridgeTestHooks.beforeDispatch = (res) => { res.destroy(); };
	const second = await post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "lh_echo", arguments: { text: "second" } } }).then((r) => r.status, () => 0);
	delete toolBridgeTestHooks.beforeDispatch;
	await new Promise((r) => setTimeout(r, 200));
	assert.ok(second === 400 || second === 0, `the reused id: ${second}`);
	assert.deepEqual(invalid, ["reused request id"]);
	assert.equal(calls.length, 1);
	assert.deepEqual(aborted, [], "the first call is still held");
	assert.equal(endpoint.resolve(calls[0]!.id, result([{ type: "text", text: "ok" }])), true);
	assert.match(await first, /ok/);
});

test("resolve() reports false when the held call's response is already gone (destroyed, close not yet seen)", async (t) => {
	const { toolBridgeTestHooks } = await import("../src/agent/antigravity/tool-bridge.ts");
	t.after(() => { delete toolBridgeTestHooks.onHeld; });
	const { endpoint, calls } = await bridgeFor(t);
	let response: { destroy(): void } | undefined;
	toolBridgeTestHooks.onHeld = (_call, res) => { response = res; };
	const c = await client(t, endpoint.mcpServer);
	void c.callTool({ name: "lh_echo", arguments: { text: "a" } }).catch(() => {});
	await until(() => calls.length === 1 && response !== undefined);
	assert.equal(endpoint.canResolve(calls[0]!.id), true);
	response!.destroy();
	assert.equal(endpoint.canResolve(calls[0]!.id), false);
	assert.equal(endpoint.resolve(calls[0]!.id, result([{ type: "text", text: "late" }])), false, "an answer is never written into a dead response");
});

test("a closing endpoint accepts nothing that was still in flight", async (t) => {
	const { toolBridgeTestHooks } = await import("../src/agent/antigravity/tool-bridge.ts");
	t.after(() => { delete toolBridgeTestHooks.beforeDispatch; });
	const { endpoint, calls } = await bridgeFor(t);
	const post = await rawSession(endpoint.mcpServer);
	toolBridgeTestHooks.beforeDispatch = () => { void endpoint.close(); };
	const status = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lh_echo", arguments: { text: "a" } } }).then((r) => r.status, () => 0);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(calls.length, 0);
	assert.ok(status === 404 || status === 0, `answered ${status}`);
	assert.equal((await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }).then((r) => r.status, () => 0)), 404, "and nothing after");
});

test("tool-result images follow the 20 MiB prompt budget: beyond it a text note, the result is never dropped", async (t) => {
	const { promptImageLimit } = await import("../src/agent/antigravity/transcript.ts");
	const saved = promptImageLimit.bytes;
	t.after(() => { promptImageLimit.bytes = saved; });
	promptImageLimit.bytes = 4;
	const { endpoint, calls } = await bridgeFor(t);
	const c = await client(t, endpoint.mcpServer);
	const pending = c.callTool({ name: "lh_echo", arguments: { text: "a" } });
	await until(() => calls.length === 1);
	endpoint.resolve(calls[0]!.id, result([{ type: "text", text: "pages" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "image", data: "AAAAAAAA", mimeType: "image/png" }]));
	const answer = await pending as { content: { type: string; text?: string }[] };
	assert.deepEqual(answer.content.map((b) => b.type), ["text", "image", "text"]);
	assert.match(answer.content[2]!.text!, /image omitted/i);
});
