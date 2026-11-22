/**
 * The large JSON reads leave content encoding to Next's own compression.
 * A route handler that also gzips its body goes out encoded twice on Next
 * 16.4.6 and the app cannot parse it (2026-11-22: the chat list, graph and
 * model list were unreadable after the upgrade).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-json-response-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "empty-auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });
const { chatStore } = await import("../src/store/chats.ts");
const chatRoute = await import("../app/api/chats/[id]/route.ts");
const chatList = await import("../app/api/chats/route.ts");
const graphRoute = await import("../app/api/graph/route.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const big = chatStore.createChat("large read fixture");
chatStore.saveMessages(
	big.id,
	Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, role: "user" as const, content: `Step ${i}: the chain rule, d/dx f(g(x)) = f'(g(x))·g'(x), ünïcode ∂ check.`, timestamp: i })),
);
const gzipRequest = (url: string) => new Request(url, { headers: { "Accept-Encoding": "gzip, br" } });
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

test("the large reads answer unencoded bodies, so the server encodes them exactly once", async () => {
	const reads: [string, Response][] = [
		["chat open", await chatRoute.GET(gzipRequest(`http://localhost/api/chats/${big.id}`), { params: Promise.resolve({ id: big.id }) })],
		["chat list", await chatList.GET()],
		["graph", await graphRoute.GET()],
	];
	for (const [name, response] of reads) {
		assert.equal(response.status, 200, name);
		assert.equal(response.headers.get("content-encoding"), null, `${name}: no Content-Encoding from the route`);
		const body = Buffer.from(await response.arrayBuffer());
		assert.notDeepEqual(body.subarray(0, 2), GZIP_MAGIC, `${name}: the body is not gzip bytes`);
		JSON.parse(body.toString("utf8"));
	}
	const chat = await (await chatRoute.GET(gzipRequest(`http://localhost/api/chats/${big.id}`), { params: Promise.resolve({ id: big.id }) })).json();
	assert.equal(chat.messages.length, 300);
});
