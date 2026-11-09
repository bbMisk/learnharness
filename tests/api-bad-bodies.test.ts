/**
 * Null, malformed or non-object JSON bodies get a 4xx, never a 500, and a
 * junk POST /api/chats creates no chat.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-bad-bodies-"));
process.env.LH_DATA_DIR = TMP_DATA;

const chats = await import("../app/api/chats/route.ts");
const chat = await import("../app/api/chat/route.ts");
const extract = await import("../app/api/graph/coverage/extract/route.ts");
const steer = await import("../app/api/chats/[id]/steer/route.ts");
const { listChats } = await import("../src/server/index.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const post = (body: string) => new Request("http://test/api", { method: "POST", headers: { "Content-Type": "application/json" }, body });
const JUNK = ["null", "{", "", "[]", '"x"', "123", '{"title":5}'];

it("POST /api/chats rejects junk bodies without creating chats", async () => {
	const before = listChats().length;
	for (const body of JUNK) {
		const res = await chats.POST(post(body));
		assert.equal(res.status, 400, `body ${JSON.stringify(body)}`);
	}
	assert.equal(listChats().length, before);
	assert.equal((await chats.POST(post('{"title":"ok"}'))).status, 200);
});

it("POST /api/chat, /api/graph/coverage/extract and /api/chats/<id>/steer answer 4xx", async () => {
	const { id } = (await (await chats.POST(post("{}"))).json()) as { id: string };
	const params = { params: Promise.resolve({ id }) };
	for (const body of JUNK) {
		const label = `body ${JSON.stringify(body)}`;
		const a = await chat.POST(post(body));
		assert.ok(a.status >= 400 && a.status < 500, `/api/chat ${label}: ${a.status}`);
		const b = await extract.POST(post(body));
		assert.ok(b.status >= 400 && b.status < 500, `extract ${label}: ${b.status}`);
		const c = await steer.POST(post(body), params);
		assert.ok(c.status >= 400 && c.status < 500, `steer ${label}: ${c.status}`);
	}
});
