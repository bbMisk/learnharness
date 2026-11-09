import assert from "node:assert/strict";
import { test } from "node:test";
import { readSettings } from "../components/settings-read.ts";

/** Opening a chat mounted several settings readers, each sending its own
 *  GET /api/settings. Reads in one synchronous run now share one request; a
 *  later read (say, after a save) starts a fresh one. */
test("settings reads in the same task share one request", async () => {
	const real = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		return Response.json({ settings: { version: 1 } });
	}) as typeof fetch;
	try {
		// One commit's mount effects run in one synchronous loop.
		const [a, b, c] = await Promise.all([readSettings(), readSettings(), readSettings()]);
		assert.equal(calls, 1);
		assert.deepEqual([a, b, c].map((body) => body.settings?.version), [1, 1, 1]);
		await readSettings();
		assert.equal(calls, 2, "a later read is fresh");
		globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
		await assert.rejects(readSettings(), /settings read failed: 500/);
	} finally {
		globalThis.fetch = real;
	}
});
