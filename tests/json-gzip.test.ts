/** Gzip JSON transport (src/server/json-response.ts): large route-handler
 *  reads are gzip-encoded only when the request accepts it, decode to the
 *  identical bytes, and the SSE/turn streams stay untouched. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-json-gzip-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "empty-auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });
const { chatStore } = await import("../src/store/chats.ts");
const { acceptsGzip, jsonResponse, MIN_GZIP_BYTES } = await import("../src/server/json-response.ts");
const chatRoute = await import("../app/api/chats/[id]/route.ts");
const chatList = await import("../app/api/chats/route.ts");
const historyRoute = await import("../app/api/learning-history/route.ts");
const graphRoute = await import("../app/api/graph/route.ts");
const eventsRoute = await import("../app/api/events/route.ts");
const streamRoute = await import("../app/api/chats/[id]/stream/route.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const big = chatStore.createChat("gzip fixture");
chatStore.saveMessages(
	big.id,
	Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, role: "user" as const, content: `Step ${i}: the chain rule, d/dx f(g(x)) = f'(g(x))·g'(x) — ünïcode ∂ check.`, timestamp: i })),
);
const params = { params: Promise.resolve({ id: big.id }) };
const request = (url: string, encoding?: string) => new Request(url, encoding === undefined ? {} : { headers: { "Accept-Encoding": encoding } });
const bytes = async (response: Response) => Buffer.from(await response.arrayBuffer());

test("Accept-Encoding negotiation honours q-values and the wildcard", () => {
	for (const yes of ["gzip", "gzip, deflate, br", "br;q=1.0, gzip;q=0.8, *;q=0.1", "*", "deflate, x-gzip", "GZIP"]) assert.equal(acceptsGzip(yes), true, yes);
	for (const no of [null, undefined, "", "identity", "br", "gzip;q=0", "gzip;q=0, *", "*;q=0", "br, *;q=0", "gzip;q=nonsense", "gzip ;q=0, *;q=1", "gzip; q = 0, *"]) assert.equal(acceptsGzip(no), false, String(no));
});

test("a large chat read is gzip when accepted, plain otherwise, and decodes byte for byte", async () => {
	const url = `http://localhost/api/chats/${big.id}`;
	const plain = await chatRoute.GET(request(url), params);
	assert.equal(plain.status, 200);
	assert.equal(plain.headers.get("content-encoding"), null);
	assert.equal(plain.headers.get("content-type"), "application/json");
	assert.match(plain.headers.get("vary") ?? "", /Accept-Encoding/i, "both variants name the negotiating header");
	const plainBytes = await bytes(plain);
	assert.ok(plainBytes.length > 20_000, `fixture is large (${plainBytes.length} B)`);
	// The pre-helper wire form: identical to Response.json of the same view.
	assert.deepEqual(JSON.parse(plainBytes.toString("utf8")).messages, chatStore.getChat(big.id)!.messages);

	const gz = await chatRoute.GET(request(url, "gzip, deflate, br"), params);
	assert.equal(gz.status, 200);
	assert.equal(gz.headers.get("content-encoding"), "gzip");
	assert.equal(gz.headers.get("content-type"), "application/json");
	assert.match(gz.headers.get("vary") ?? "", /Accept-Encoding/i);
	assert.equal(gz.headers.get("content-length"), null, "no stale identity length on an encoded body");
	const gzBytes = await bytes(gz);
	assert.ok(gzBytes.length < plainBytes.length / 4, `gzip shrinks it (${gzBytes.length} vs ${plainBytes.length})`);
	assert.ok(gunzipSync(gzBytes).equals(plainBytes), "decoded body equals the uncompressed body byte for byte");

	const refused = await chatRoute.GET(request(url, "gzip;q=0, br"), params);
	assert.equal(refused.headers.get("content-encoding"), null);
	assert.ok((await bytes(refused)).equals(plainBytes));
});

test("the other covered reads decode to their identity bytes; small bodies stay plain", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 }); // learning history stamps exportedAt
	const cases: [string, (r: Request) => Promise<Response>][] = [
		[`http://localhost/api/learning-history?chatId=${big.id}`, (r) => historyRoute.GET(r)],
		["http://localhost/api/chats", (r) => chatList.GET(r)],
		["http://localhost/api/graph", (r) => graphRoute.GET(r)],
	];
	for (const [url, get] of cases) {
		const plain = await bytes(await get(request(url)));
		const gz = await get(request(url, "gzip"));
		const encoded = gz.headers.get("content-encoding") === "gzip";
		assert.equal(encoded, plain.length >= MIN_GZIP_BYTES, `${url}: gzip exactly when ≥ threshold (${plain.length} B)`);
		const wire = await bytes(gz);
		assert.ok((encoded ? gunzipSync(wire) : wire).equals(plain), url);
	}
	// The learning history carries the big transcript, so it is the large case here.
	const history = await historyRoute.GET(request(`http://localhost/api/learning-history?chatId=${big.id}`, "gzip"));
	assert.equal(history.headers.get("content-encoding"), "gzip");
	assert.equal(history.headers.get("cache-control"), "no-store", "route headers survive");

	const missing = await chatRoute.GET(request("http://localhost/api/chats/missing", "gzip"), { params: Promise.resolve({ id: "missing" }) });
	assert.equal(missing.headers.get("content-encoding"), null);
	assert.deepEqual(await missing.json(), { error: "Not found" });
});

test("no-transform and HEAD opt out; init status and headers carry through", async () => {
	const data = { blob: "x".repeat(10_000) };
	const kept = jsonResponse(request("http://localhost/x", "gzip"), data, { headers: { "Cache-Control": "no-cache, no-transform" } });
	assert.equal(kept.headers.get("content-encoding"), null);
	const head = jsonResponse(new Request("http://localhost/x", { method: "HEAD", headers: { "Accept-Encoding": "gzip" } }), data);
	assert.equal(head.headers.get("content-encoding"), null);
	const created = jsonResponse(request("http://localhost/x", "gzip"), data, { status: 201, headers: { Vary: "Origin", "Content-Length": "5" } });
	assert.equal(created.status, 201);
	assert.equal(created.headers.get("vary"), "Origin, Accept-Encoding");
	assert.equal(created.headers.get("content-length"), null);
	assert.deepEqual(JSON.parse(gunzipSync(await bytes(created)).toString("utf8")), data);
});

test("SSE and turn streams are never encoded", async () => {
	const events = eventsRoute.GET();
	assert.equal(events.headers.get("content-type"), "text/event-stream");
	assert.equal(events.headers.get("content-encoding"), null);
	assert.match(events.headers.get("cache-control") ?? "", /no-transform/);
	await events.body?.cancel();

	const stream = await streamRoute.GET(request(`http://localhost/api/chats/${big.id}/stream`, "gzip, deflate, br"), { params: Promise.resolve({ id: big.id }) });
	assert.equal(stream.headers.get("content-type"), "text/event-stream");
	assert.equal(stream.headers.get("content-encoding"), null);
	assert.match(await stream.text(), /turn-settled/);
});

test("over real HTTP, fetch decodes the gzip body transparently and res.json() parses", async () => {
	// Stand-in for Next's sendResponse: copy status + headers, pipe the Web body.
	const seen: (string | undefined)[] = [];
	const server = http.createServer(async (req, res) => {
		seen.push(req.headers["accept-encoding"]);
		const response = await chatRoute.GET(new Request(`http://localhost${req.url}`, { headers: req.headers as Record<string, string> }), params);
		res.writeHead(response.status, Object.fromEntries(response.headers));
		Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = server.address() as { port: number };
		const raw = await new Promise<{ encoding?: string; size: number }>((resolve, reject) => {
			http.get({ port, path: `/api/chats/${big.id}`, headers: { "Accept-Encoding": "gzip" } }, (res) => {
				let size = 0;
				res.on("data", (c: Buffer) => (size += c.length)).on("end", () => resolve({ encoding: res.headers["content-encoding"], size })).on("error", reject);
			}).on("error", reject);
		});
		assert.equal(raw.encoding, "gzip", "the wire carries gzip");
		const response = await fetch(`http://127.0.0.1:${port}/api/chats/${big.id}`);
		assert.match(seen.at(-1) ?? "", /gzip/, "fetch advertises gzip by default");
		const body = await response.json();
		assert.equal(body.id, big.id);
		assert.deepEqual(body.messages, chatStore.getChat(big.id)!.messages);
		assert.ok(raw.size < JSON.stringify(body).length / 4);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});
