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

test("updates and permission requests for a session not yet watched are kept and replayed on watch", async (t) => {
	const { child, connection: c } = connection(t);
	const permission = { jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { sessionId: "s1", toolCall: { title: "Run ls" }, options: [{ optionId: "no", kind: "reject_once" }] } };
	child.send(update("s1", 1), permission, { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "tool_call", title: "Run ls" } } });
	await tick();
	// Answered at once, before anyone watches.
	assert.deepEqual(child.written.find((m) => m.id === 7), { jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: "no" } } });
	const r = recorder();
	c.watch("s1", r.listener);
	assert.equal(r.updates.length, 2);
	assert.equal((r.updates[1] as { sessionUpdate: string }).sessionUpdate, "tool_call");
	assert.equal(r.permissions.length, 1);
	child.send(update("s1", 2));
	await tick();
	assert.equal(r.updates.length, 3, "live updates flow after the replay");
});

test("the early buffer is bounded: 200 entries per session, 20 sessions, 10 s", async (t) => {
	const { child, connection: c } = connection(t);
	child.send(...Array.from({ length: 250 }, (_, n) => update("big", n)));
	child.send(...Array.from({ length: 25 }, (_, n) => update(`s${n}`, n)));
	await tick();
	const big = recorder();
	c.watch("big", big.listener);
	assert.equal(big.updates.length, 0, "the oldest session was dropped once 20 more arrived");
	const early = recorder();
	c.watch("s0", early.listener);
	assert.equal(early.updates.length, 0);
	const late = recorder();
	c.watch("s24", late.listener);
	assert.equal(late.updates.length, 1);

	const { child: child2, connection: c2 } = connection(t);
	child2.send(...Array.from({ length: 250 }, (_, n) => update("one", n)));
	await tick();
	const one = recorder();
	c2.watch("one", one.listener);
	assert.equal(one.updates.length, 200);
	assert.match(JSON.stringify(one.updates.at(-1)), /#249/, "the newest are kept");

	const realNow = Date.now;
	t.after(() => { Date.now = realNow; });
	child2.send(update("stale", 1));
	await tick();
	Date.now = () => realNow() + 10_001;
	const stale = recorder();
	c2.watch("stale", stale.listener);
	assert.equal(stale.updates.length, 0, "dropped after 10 s");
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

test("`exit` alone ends the connection: listeners told, streams destroyed, temp root removed", async (t) => {
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
