import assert from "node:assert/strict";
import { test } from "node:test";
import { readChatSettings, readSettings } from "../components/settings-read.ts";

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

/** Opening a chat read its settings twice (the model pills and the
 *  question-type chip). Same sharing, per chat. */
test("chat settings reads in the same task share one request per chat", async () => {
	const real = globalThis.fetch;
	const urls: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		urls.push(String(input));
		return Response.json({ settings: { questionType: "mcq" } });
	}) as typeof fetch;
	try {
		const [a, b] = await Promise.all([readChatSettings("chat_a"), readChatSettings("chat_a"), readChatSettings("chat_b")]);
		assert.deepEqual(urls, ["/api/chats/chat_a/settings", "/api/chats/chat_b/settings"]);
		assert.equal(a.settings?.questionType, "mcq");
		assert.equal(a, b);
		await readChatSettings("chat_a");
		assert.equal(urls.length, 3, "a later read is fresh");
		globalThis.fetch = (async () => new Response("no", { status: 404 })) as typeof fetch;
		await assert.rejects(readChatSettings("chat_a"), /settings read failed: 404/);
	} finally {
		globalThis.fetch = real;
	}
});
