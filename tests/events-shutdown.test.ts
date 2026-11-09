/** SIGTERM/SIGINT end every open /api/events stream, so the server's
 *  graceful close can finish and clients reconnect to the next server. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { eventsResponse } from "../src/server/events-stream.ts";

it("a shutdown signal closes open event streams", async () => {
	const res = eventsResponse();
	// Ending the stream must also end its socket (no keep-alive linger).
	assert.equal(res.headers.get("connection"), "close");
	const reader = res.body!.getReader();
	assert.equal(new TextDecoder().decode((await reader.read()).value), ": connected\n\n");
	// Stand-in for Next's own handler (it exits after server.close()).
	const keepAlive = () => {};
	process.on("SIGTERM", keepAlive);
	try {
		process.emit("SIGTERM", "SIGTERM");
		const next = await Promise.race([
			reader.read().then((r) => (r.done ? "ended" : "frame")),
			new Promise<"open">((resolve) => setTimeout(() => resolve("open"), 1000)),
		]);
		if (next === "open") await reader.cancel();
		assert.equal(next, "ended", "the stream ends");
		// A reconnect that still reaches this process is ended too.
		assert.equal((await eventsResponse().body!.getReader().read()).done, true);
	} finally {
		process.off("SIGTERM", keepAlive);
	}
});
