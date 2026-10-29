import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
const { sharedServerURL, normalizeServerURL, connectionSettings, saveConnection, checkServer } = createRequire(import.meta.url)("../electron/shared-server.cjs");

it("persists a remote connection, preserving the existing local host on switch back", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-shared-"));
	try {
		assert.equal(sharedServerURL(directory), undefined);
		fs.writeFileSync(path.join(directory, "shared-server.json"), JSON.stringify({ url: "http://127.0.0.1:8787" }));
		assert.equal(sharedServerURL(directory), "http://127.0.0.1:8787");
		saveConnection(directory, "https://my-mac.example.ts.net/");
		assert.deepEqual(connectionSettings(directory), { mode: "host", url: "https://my-mac.example.ts.net" });
		assert.equal(fs.statSync(path.join(directory, "shared-server.json")).mode & 0o777, 0o600);
		saveConnection(directory, null);
		assert.equal(sharedServerURL(directory), "http://127.0.0.1:8787");
		assert.equal(connectionSettings(directory).mode, "local");
	} finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
it("requires HTTPS remotely and pins the entire connection to one explicit origin", () => {
	for (const value of ["http://remote.example", "https://user:password@host.example", "file:///tmp/x", "javascript:alert(1)", "https://host.example/chat/id", "https://host.example?token=secret", "https://host.example#fragment", ""]) assert.throws(() => normalizeServerURL(value));
	assert.equal(normalizeServerURL(" https://HOST.example:443/ "), "https://host.example");
	assert.equal(normalizeServerURL("http://localhost:8787"), "http://localhost:8787");
});
it("probes identity before accepting a host; errors and other websites are rejected", async () => {
	assert.equal(await checkServer("https://host.example", async (url:string, options:RequestInit) => {
		assert.equal(url, "https://host.example/api/health");
		assert.equal(options.redirect, "error");
		return Response.json({ app: "learnharness", status: "ok" });
	}), "https://host.example");
	await assert.rejects(checkServer("https://host.example", async () => Response.json({ app: "other" })));
	await assert.rejects(checkServer("https://host.example", async () => Response.json({ app: "learnharness" }, { status: 503 })));
	await assert.rejects(checkServer("https://host.example", async () => { throw new Error("Offline"); }), /Offline/);
});
