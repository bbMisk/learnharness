/** SIGTERM/SIGINT end every open /api/events stream, so the server's
 *  graceful close can finish and clients reconnect to the next server. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { eventsResponse } from "../src/server/events-stream.ts";

it("a shutdown signal closes open event streams", async () => {
	const reader = eventsResponse().body!.getReader();
	assert.equal(new TextDecoder().decode((await reader.read()).value), ": connected\n\n");
	// Stand-in for Next's own handler (it exits after server.close()).
	const keepAlive = () => {};
	process.on("SIGTERM", keepAlive);
	try {
		process.emit("SIGTERM", "SIGTERM");
		const next = await Promise.race([reader.read(), new Promise<"open">((resolve) => setTimeout(() => resolve("open"), 1000))]);
		if (next === "open") await reader.cancel();
		assert.notEqual(next, "open", "stream still open after SIGTERM");
		assert.equal((next as { done: boolean }).done, true);
	} finally {
		process.off("SIGTERM", keepAlive);
	}
});
