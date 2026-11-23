/**
 * The NDJSON JSON-RPC peer (src/agent/antigravity/acp-client.ts), alone and
 * against the mock agent over real stdio.
 */
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";

import { AcpPeer, AcpRpcError, AcpTransportError, isAcpRpcError, isAcpTransportError, LineSplitter, LineTooLongError, MAX_LINE_BYTES, methodNotFound, stripUrls, type AcpPeerHandlers } from "../src/agent/antigravity/acp-client.ts";
import { AntigravityMessage } from "../src/agent/antigravity/constants.ts";
import { mockHarness, waitFor, type MockHarness, type MockScenario } from "./helpers/antigravity-mock.ts";

if (process.env.NODE_ENV !== "test") throw new Error("Run with NODE_ENV=test.");

const FAKE_LINK = "Open the following link to authenticate the ACP server: https://example.invalid/fake-sign-in?code=SECRET";

function sink(): { stream: Writable; lines: string[] } {
	const lines: string[] = [];
	const stream = new Writable({ write(chunk, _encoding, done) { lines.push(...String(chunk).split("\n").filter(Boolean)); done(); } });
	return { stream, lines };
}

function handlers(overrides: Partial<AcpPeerHandlers> = {}): AcpPeerHandlers & { fatal: AcpTransportError[]; notes: [string, unknown][] } {
	const fatal: AcpTransportError[] = [];
	const notes: [string, unknown][] = [];
	return {
		fatal, notes,
		onNotification: (method, params) => notes.push([method, params]),
		onRequest: (method) => { throw methodNotFound(method); },
		onFatal: (error) => fatal.push(error),
		...overrides,
	};
}

test("splitter: splits on newline across chunks and caps a line in bytes", () => {
	const splitter = new LineSplitter(10);
	assert.deepEqual(splitter.push(Buffer.from("ab")), []);
	assert.deepEqual(splitter.push(Buffer.from("c\nde\n\nf")), ["abc", "de", ""]);
	assert.deepEqual(splitter.push(Buffer.from("\n")), ["f"]);
	assert.throws(() => splitter.push(Buffer.from("x".repeat(11))), LineTooLongError);
	const multibyte = new LineSplitter(4);
	assert.throws(() => multibyte.push(Buffer.from("ééé")), LineTooLongError, "6 bytes, 3 characters");
});

test("peer: answers, errors, CRLF and blank lines; a line over 16 MiB is a protocol error", async () => {
	const out = sink();
	const h = handlers();
	const peer = new AcpPeer(out.stream, h);
	const answered = peer.request("initialize", { a: 1 });
	const failed = peer.request("session/new", {});
	assert.deepEqual(out.lines.map((line) => JSON.parse(line)), [
		{ jsonrpc: "2.0", id: 1, method: "initialize", params: { a: 1 } },
		{ jsonrpc: "2.0", id: 2, method: "session/new", params: {} },
	]);
	peer.receive(Buffer.from('\n  \r\n{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\r\n{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}\n'));
	assert.deepEqual(await answered, { ok: true });
	await assert.rejects(failed, (error: unknown) => error instanceof AcpRpcError && error.code === -32000);
	peer.receive(Buffer.from('{"jsonrpc":"2.0","method":"session/update","params":{"x":1}}\n'));
	assert.deepEqual(h.notes, [["session/update", { x: 1 }]]);
	assert.equal(h.fatal.length, 0);

	const pending = peer.request("session/prompt", {});
	peer.receive(Buffer.alloc(MAX_LINE_BYTES + 1, 0x61));
	assert.equal(h.fatal.length, 1);
	assert.equal(h.fatal[0]!.kind, "protocol");
	await assert.rejects(pending, AcpTransportError);
	await assert.rejects(peer.request("initialize", {}), AcpTransportError, "a closed peer refuses new requests");
});

test("peer: a non-JSON line is fatal and its text appears nowhere", async () => {
	const h = handlers();
	const peer = new AcpPeer(sink().stream, h);
	const pending = peer.request("initialize", {});
	peer.receive(Buffer.from("panic: secret detail\n"));
	await assert.rejects(pending, (error: unknown) => error instanceof AcpTransportError && error.message === AntigravityMessage.ProtocolError);
	assert.equal(h.fatal.length, 1);
	assert(!JSON.stringify(h.fatal.map((e) => e.message)).includes("secret"));
});

test("peer: the sign-in line means not signed in and the link appears nowhere", async () => {
	const h = handlers();
	const peer = new AcpPeer(sink().stream, h);
	const pending = peer.request("initialize", {});
	peer.receive(Buffer.from(`${FAKE_LINK}\n`));
	await assert.rejects(pending, (error: unknown) => error instanceof AcpTransportError && error.kind === "sign-in" && error.message === AntigravityMessage.NotSignedIn);
	assert.equal(h.fatal[0]!.kind, "sign-in");
	assert(!JSON.stringify(h.fatal.map((e) => e.message)).includes("example.invalid"));
});

test("peer: a request timeout rejects only that request", async () => {
	const peer = new AcpPeer(sink().stream, handlers());
	await assert.rejects(peer.request("initialize", {}, 20), (error: unknown) => error instanceof AcpTransportError && error.kind === "timeout");
	assert.equal(peer.closed, false);
});

function connect(h: MockHarness) {
	const child = h.launch(["acp", "--sandbox"], { cwd: tmpdir(), env: { ...process.env } });
	assert.ok(child);
	const peerHandlers = handlers();
	const peer = new AcpPeer(child.stdin, peerHandlers);
	child.stdout.on("data", (chunk: Buffer) => peer.receive(chunk));
	return { child, peer, peerHandlers };
}

async function withMock(t: TestContext, scenario: MockScenario, body: (c: ReturnType<typeof connect>, h: MockHarness) => Promise<void>) {
	const h = mockHarness(t, scenario);
	const connection = connect(h);
	try { await body(connection, h); }
	finally { connection.child.stdin.end(); }
	await h.assertNoChildren();
}

test("mock: initialize answers protocolVersion 2 with the v1 shapes, launched as `acp --sandbox`", async (t) => {
	await withMock(t, {}, async ({ peer }, h) => {
		const result = await peer.request("initialize", { protocolVersion: 1 }) as Record<string, unknown>;
		assert.equal(result.protocolVersion, 2);
		assert.ok(result.agentInfo && result.agentCapabilities);
		assert.deepEqual(h.log()[0]!.argv, ["acp", "--sandbox"]);
		assert.deepEqual(h.methods(), ["initialize"]);
	});
});

test("mock: an agent request LearnHarness doesn't serve gets -32601", async (t) => {
	await withMock(t, { prompt: [{ fsRead: true }] }, async ({ peer }, h) => {
		await peer.request("initialize", {});
		const { sessionId } = await peer.request("session/new", { cwd: tmpdir(), mcpServers: [] }) as { sessionId: string };
		assert.deepEqual(await peer.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] }), { stopReason: "end_turn" });
		const answer = h.log().find((entry) => entry.kind === "fs-answer")?.answer as { error: { code: number; message: string } };
		assert.deepEqual(answer.error, { code: -32601, message: "Method not found: fs/read_text_file" });
	});
});

test("mock: not signed in as -32000, and as the stdout link line", async (t) => {
	await withMock(t, { initializeError: { code: -32000, message: "Authentication required" } }, async ({ peer }) => {
		await assert.rejects(peer.request("initialize", {}), (error: unknown) => error instanceof AcpRpcError && error.code === -32000);
	});
	await withMock(t, { stdoutAtStart: [FAKE_LINK] }, async ({ peer, peerHandlers }) => {
		await waitFor(() => peerHandlers.fatal.length > 0, 3000, "sign-in line");
		assert.equal(peerHandlers.fatal[0]!.kind, "sign-in");
		await assert.rejects(peer.request("initialize", {}), AcpTransportError);
	});
});

test("mock: a non-JSON stdout line is a protocol error", async (t) => {
	await withMock(t, { stdoutAtStart: ["Starting up, please wait"] }, async ({ peerHandlers }) => {
		await waitFor(() => peerHandlers.fatal.length > 0, 3000, "protocol error");
		assert.equal(peerHandlers.fatal[0]!.kind, "protocol");
	});
});

test("peer: any non-null error member is an error; a response with neither result nor error is a protocol error", async () => {
	const h = handlers();
	const peer = new AcpPeer(sink().stream, h);
	const stringError = peer.request("a", {});
	const nullResult = peer.request("b", {});
	peer.receive(Buffer.from('{"jsonrpc":"2.0","id":1,"error":"boom"}\n{"jsonrpc":"2.0","id":2,"result":null}\n'));
	await assert.rejects(stringError, (error: unknown) => isAcpRpcError(error) && error.code === -32603);
	assert.equal(await nullResult, null);
	const empty = peer.request("c", {});
	peer.receive(Buffer.from('{"jsonrpc":"2.0","id":3}\n'));
	await assert.rejects(empty, (error: unknown) => isAcpTransportError(error) && error.kind === "protocol");
	assert.equal(h.fatal[0]!.kind, "protocol");
});

test("errors are classified by brand, so ones built by an older copy of the module still count", () => {
	const foreignRpc = Object.assign(new Error("Authentication required"), { brand: "acp-rpc", code: -32000 });
	const foreignTransport = Object.assign(new Error(AntigravityMessage.Exited), { brand: "acp-transport", kind: "closed" });
	assert.equal(foreignRpc instanceof AcpRpcError, false);
	assert.equal(isAcpRpcError(foreignRpc), true);
	assert.equal(isAcpTransportError(foreignTransport), true);
	assert.equal(isAcpRpcError(new Error("plain")), false);
});

test("stripUrls removes scheme links, scheme-relative links and anything naming accounts.google.com", () => {
	assert.equal(stripUrls("see https://example.invalid/a?b=1 now"), "see [link removed] now");
	assert.equal(stripUrls("open //evil.example/path?code=1 please"), "open [link removed] please");
	assert.equal(stripUrls("(//evil.example/x)"), "([link removed]");
	assert.equal(stripUrls("//host-at-start/p"), "[link removed]");
	assert.equal(stripUrls("go to accounts.google.com/o/oauth2/auth?x=1 now"), "go to [link removed] now");
	assert.equal(stripUrls("ACCOUNTS.GOOGLE.COM"), "[link removed]");
	assert.equal(stripUrls("a / b // c"), "a / b // c", "a bare // with no host stays");
	assert.equal(stripUrls("1/2 and a/b/c"), "1/2 and a/b/c");
});
