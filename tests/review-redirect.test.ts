import assert from "node:assert/strict";
import { it } from "node:test";
import { GET } from "../app/review/route.ts";

it("/review redirects relative to the host the client used", async () => {
	const res = await (GET as (request: Request) => Promise<Response>)(new Request("http://localhost:3904/review", { headers: { Host: "100.64.1.2:3904" } }));
	assert.equal(res.status, 307);
	assert.equal(res.headers.get("location"), "/review/index.html");
});
