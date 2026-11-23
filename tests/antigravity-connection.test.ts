/**
 * AgentConnection (src/agent/antigravity/runtime.ts) over a fake child
 * process, so stdout can be fed byte for byte and exit/error events can be
 * fired alone: early-update buffering and its bounds, watch() refusals,
 * listener isolation, `exit` without `close`, spawn errors, timer refs.
 * Nothing is spawned here.
 */
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import test, { type TestContext } from "node:test";

import { AntigravityMessage } from "../src/agent/antigravity/constants.ts";
import { AgentConnection, antigravityTimeouts, type SessionListener } from "../src/agent/antigravity/runtime.ts";
import { waitFor } from "./helpers/antigravity-mock.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

const DEFAULTS = { ...antigravityTimeouts };

class FakeChild extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	pid: number | undefined = 4242;
	written: Record<string, unknown>[] = [];
	signals: string[] = [];
	exitOnKill = true;
	constructor() {
		super();
		this.stdin.on("data", (chunk: Buffer) => { for (const line of String(chunk).split("\n").filter(Boolean)) this.written.push(JSON.parse(line)); });
	}
	kill(signal = "SIGTERM") {
		this.signals.push(signal);
		if (this.exitOnKill) setImmediate(() => this.emit("exit", null, signal));
		return true;
	}
	send(...messages: unknown[]) {
		this.stdout.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
	}
}

function connection(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "lh-agy-conn-"));
	mkdirSync(join(root, "workspace"));
	const child = new FakeChild();
	const value = new AgentConnection(child as unknown as ChildProcessWithoutNullStreams, root);
	t.after(() => {
		Object.assign(antigravityTimeouts, DEFAULTS);
		if (value.alive) value.kill();
		rmSync(root, { recursive: true, force: true });
	});
	return { child, connection: value, root };
}

function recorder() {
	const updates: unknown[] = [];
	const permissions: unknown[] = [];
	const closed: string[] = [];
	const listener: SessionListener = {
		onUpdate: (update) => updates.push(update),
		onPermissionRequest: (params) => { permissions.push(params); return { outcome: { outcome: "cancelled" } }; },
		onClosed: (error) => closed.push(error.message),
	};
	return { listener, updates, permissions, closed };
}

const update = (sessionId: string, n: number) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `#${n}` } } } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

const sessionUpdate = (sessionId: string, body: Record<string, unknown>) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });

test("before watch, only a sticky breach and the latest options/mode are kept, never text", async (t) => {
	const { child, connection: c } = connection(t);
	const permission = { jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { sessionId: "s1", toolCall: { title: "Run ls", kind: "execute" }, options: [{ optionId: "no", kind: "reject_once" }] } };
	child.send(
		update("s1", 1),
		permission,
		sessionUpdate("s1", { sessionUpdate: "tool_call", title: "Second tool" }),
		sessionUpdate("s1", { sessionUpdate: "config_option_update", configOptions: [{ id: "mode", currentValue: "auto" }] }),
		sessionUpdate("s1", { sessionUpdate: "config_option_update", configOptions: [{ id: "mode", currentValue: "default" }] }),
		sessionUpdate("s1", { sessionUpdate: "current_mode_update", currentModeId: "plan" }),
		update("s1", 2),
	);
	await tick();
	// Answered at once, before anyone watches.
	assert.deepEqual(child.written.find((m) => m.id === 7), { jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: "no" } } });
	const r = recorder();
	c.watch("s1", r.listener);
	assert.deepEqual(r.updates, [
		{ sessionUpdate: "config_option_update", configOptions: [{ id: "mode", currentValue: "default" }] },
		{ sessionUpdate: "current_mode_update", currentModeId: "plan" },
	], "latest options and mode only; no chunk is kept");
	assert.deepEqual(r.permissions, [{ sessionId: "s1", toolCall: { title: "Run ls", kind: "execute" }, options: [] }], "the first breach, sticky");
	child.send(update("s1", 3));
	await tick();
	assert.equal(r.updates.length, 3, "live updates flow after the replay");
});

test("the early map holds 20 sessions and drops the oldest one WITHOUT a breach first", async (t) => {
	const { child, connection: c } = connection(t);
	child.send(sessionUpdate("breached", { sessionUpdate: "tool_call", title: "Early tool" }));
	child.send(...Array.from({ length: 25 }, (_, n) => sessionUpdate(`s${n}`, { sessionUpdate: "current_mode_update", currentModeId: "auto" })));
	await tick();
	const breached = recorder();
	c.watch("breached", breached.listener);
	assert.deepEqual(breached.updates, [{ sessionUpdate: "tool_call", title: "Early tool", kind: undefined }], "a breach outlives later sessions");
	const oldest = recorder();
	c.watch("s0", oldest.listener);
	assert.equal(oldest.updates.length, 0, "evicted");
	const newest = recorder();
	c.watch("s24", newest.listener);
	assert.equal(newest.updates.length, 1);
	// A chunk alone creates no entry at all.
	child.send(update("chatty", 1));
	await tick();
	const chatty = recorder();
	c.watch("chatty", chatty.listener);
	assert.equal(chatty.updates.length, 0);
});

test("watch refuses an empty id and a second listener; the first keeps its updates", async (t) => {
	const { child, connection: c } = connection(t);
	const first = recorder();
	c.watch("s1", first.listener);
	assert.throws(() => c.watch("s1", recorder().listener), (error: Error) => error.message === AntigravityMessage.ProtocolError);
	assert.throws(() => c.watch("", recorder().listener), (error: Error) => error.message === AntigravityMessage.ProtocolError);
	child.send(update("s1", 1));
	await tick();
	assert.equal(first.updates.length, 1);
});

test("a throwing listener never escapes the stdout handler", async (t) => {
	const { child, connection: c } = connection(t);
	const logged: unknown[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => { logged.push(args); };
	t.after(() => { console.error = original; });
	const boom: SessionListener = {
		onUpdate: () => { throw new Error("listener bug"); },
		onPermissionRequest: () => { throw new Error("listener bug"); },
		onClosed: () => { throw new Error("listener bug"); },
	};
	c.watch("s1", boom);
	const other = recorder();
	c.watch("s2", other.listener);
	child.send(update("s1", 1), { jsonrpc: "2.0", id: 9, method: "session/request_permission", params: { sessionId: "s1", options: [] } }, update("s2", 2));
	await tick();
	assert.equal(other.updates.length, 1, "later lines in the same chunk still arrive");
	assert.deepEqual(child.written.find((m) => m.id === 9)?.result, { outcome: { outcome: "cancelled" } });
	assert.equal(c.alive, true);
	assert.equal(logged.length, 1, "logged once");
	child.emit("exit", 1, null);
	await c.closed;
});

test("`exit` alone ends the connection after the drain delay: listeners told, streams destroyed, temp root removed", async (t) => {
	const { child, connection: c, root } = connection(t);
	const r = recorder();
	c.watch("s1", r.listener);
	const pending = c.request("session/prompt", { sessionId: "s1" });
	const original = console.error;
	console.error = () => {};
	t.after(() => { console.error = original; });
	child.emit("exit", 1, null);
	assert.equal((await c.closed).message, AntigravityMessage.Exited);
	await assert.rejects(pending);
	assert.deepEqual(r.closed, [AntigravityMessage.Exited]);
	assert.equal(child.stdout.destroyed && child.stdin.destroyed && child.stderr.destroyed, true);
	await waitFor(() => !existsSync(root), 2000, "temp root removed");
});

test("a spawn error with no exit or close still cleans up", async (t) => {
	const { child, connection: c, root } = connection(t);
	child.pid = undefined;
	const original = console.error;
	console.error = () => {};
	t.after(() => { console.error = original; });
	child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
	assert.equal((await c.closed).message, AntigravityMessage.Exited);
	assert.equal(c.alive, false);
	await waitFor(() => !existsSync(root), 2000, "temp root removed");
});

test("the kill and inactivity-free paths hold no timer that keeps the server alive", async (t) => {
	const { child, connection: c } = connection(t);
	child.exitOnKill = false;
	antigravityTimeouts.killGraceMs = 60_000;
	const before = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
	c.kill();
	const after = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
	assert.equal(after, before, "the SIGKILL grace timer is unref'd");
	child.emit("exit", null, "SIGTERM");
	await c.closed;
});

test("the sign-in line counts without a newline and after leading spaces", async (t) => {
	for (const raw of ["Open the following link to authenticate the ACP server: https://example.invalid/x", "   Open the following link to authenticate the ACP server: https://example.invalid/x\n"]) {
		const { child, connection: c } = connection(t);
		const pending = c.request("initialize", {});
		child.stdout.write(raw);
		await assert.rejects(pending, (error: Error) => error.message === AntigravityMessage.NotSignedIn);
		await c.closed;
	}
	// Split across chunks.
	const { child, connection: c } = connection(t);
	const pending = c.request("initialize", {});
	child.stdout.write("Open the following ");
	await sleep(10);
	child.stdout.end("link to authenticate");
	await assert.rejects(pending, (error: Error) => error.message === AntigravityMessage.NotSignedIn);
});

test("after `exit`, output still in the pipe is read: a final answer within the drain delay resolves", async (t) => {
	const { child, connection: c } = connection(t);
	antigravityTimeouts.exitDrainMs = 200;
	const pending = c.request("session/prompt", { sessionId: "s1" });
	child.emit("exit", 0, null);
	assert.equal(c.alive, false, "no new turn may use it");
	child.send({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
	assert.deepEqual(await pending, { stopReason: "end_turn" });
	child.emit("close", 0, null);
	await c.closed;
});

test("a frame without jsonrpc \"2.0\" is a protocol error", async (t) => {
	for (const frame of [{ id: 1, result: {} }, { jsonrpc: "1.0", id: 1, result: {} }, { jsonrpc: 2, method: "session/update", params: {} }]) {
		const { child, connection: c } = connection(t);
		const pending = c.request("initialize", {});
		child.send(frame);
		await assert.rejects(pending, (error: Error) => error.message === AntigravityMessage.ProtocolError, JSON.stringify(frame));
		await c.closed;
	}
});

test("a second child `error` is handled, and kill calls that throw never escape", async (t) => {
	const { child, connection: c } = connection(t);
	child.exitOnKill = false;
	child.kill = () => { throw new Error("ESRCH"); };
	assert.doesNotThrow(() => { child.emit("error", new Error("first")); child.emit("error", new Error("second")); });
	assert.equal(c.alive, false);
	assert.doesNotThrow(() => c.killNow());
	child.emit("exit", null, "SIGKILL");
	await c.closed;
});

test("turning the provider off stops an unused agent at once, and a busy one when its last turn lets go", async (t) => {
	const idle = connection(t);
	idle.connection.stopWhenUnused();
	assert.equal(idle.connection.alive, false);
	assert.deepEqual(idle.child.signals, ["SIGTERM"]);

	const busy = connection(t);
	const release = busy.connection.hold();
	busy.connection.stopWhenUnused();
	assert.equal(busy.connection.alive, true, "a reply in flight is not cut off");
	assert.deepEqual(busy.child.signals, []);
	release();
	assert.equal(busy.connection.alive, false);
	assert.deepEqual(busy.child.signals, ["SIGTERM"]);
	await busy.connection.closed;
});
