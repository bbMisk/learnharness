import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.ts";

const origin = "http://127.0.0.1:3000";
test("a link with broken percent-encoding shows the app's not-found page, not a bare error", () => {
	for (const path of ["/chat/%E0%A4%A", "/project/%E0%A4%A", "/chat/%"]) {
		const response = proxy(new NextRequest(origin + path));
		assert.equal(new URL(response.headers.get("x-middleware-rewrite") ?? origin).pathname, "/_lh-broken-link", path);
	}
	for (const path of ["/chat/new", "/project/%41bc", "/chat/caf%C3%A9", "/api/chats/%E0%A4%A"]) {
		const response = proxy(new NextRequest(origin + path));
		assert.equal(response.headers.get("x-middleware-rewrite"), null, path);
		assert.equal(response.headers.get("x-middleware-next"), "1", path);
	}
});
