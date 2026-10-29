import { it } from "node:test";
import assert from "node:assert/strict";
import { remoteAccessError } from "../src/core/remote-access.ts";

const config = { owner: "owner@example.com", host: "learn.example.ts.net", port: "8787" };
const request = (headers: Record<string, string>, method = "GET") => ({ headers: new Headers(headers), method });
it("permits the owner through Serve and the local desktop, refusing unrelated identities and hostnames", () => {
	assert.equal(remoteAccessError(request({ host: config.host, "tailscale-user-login": config.owner }), config), null);
	assert.equal(remoteAccessError(request({ host: "127.0.0.1:8787" }), config), null);
	assert.ok(remoteAccessError(request({ host: config.host }), config));
	assert.ok(remoteAccessError(request({ host: config.host, "tailscale-user-login": "other@example.com" }), config));
	assert.ok(remoteAccessError(request({ host: "evil.example", "tailscale-user-login": config.owner }), config));
});
it("refuses cross-origin writes while keeping normal same-origin browser requests", () => {
	assert.equal(remoteAccessError(request({ host: config.host, "tailscale-user-login": config.owner, origin: `https://${config.host}` }, "POST"), config), null);
	assert.ok(remoteAccessError(request({ host: config.host, "tailscale-user-login": config.owner, origin: "https://evil.example" }, "POST"), config));
	assert.ok(remoteAccessError(request({ host: "127.0.0.1:8787", "sec-fetch-site": "cross-site" }, "DELETE"), config));
	assert.equal(remoteAccessError(request({ host: "localhost:3000" }), {}), null);
});
