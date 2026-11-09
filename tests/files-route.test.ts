/** QA r2 robust #8: POST /api/files answers with only what the client uses. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-files-route-"));
process.env.LH_DATA_DIR = root;
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
const route = await import("../app/api/files/route.ts");
after(() => fs.rmSync(root, { recursive: true, force: true }));

it("an upload returns only the stored file's path", async () => {
	const response = await route.POST(new Request("http://test/api/files?name=notes.txt", { method: "POST", body: "hello", headers: { "content-length": "5" } }));
	assert.equal(response.status, 201);
	const body = (await response.json()) as Record<string, unknown>;
	assert.deepEqual(Object.keys(body), ["path"]);
	assert.equal(fs.readFileSync(body.path as string, "utf8"), "hello");
});
