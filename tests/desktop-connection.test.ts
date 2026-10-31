import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { it } from "node:test";

const electronDir = fileURLToPath(new URL("../electron/", import.meta.url));
const { createConnectionIPC } = createRequire(import.meta.url)("../electron/connection-ipc.cjs");

it("the connection IPC trusts only the configured top frame or the exact bundled recovery page", () => {
	const { connectionSenders, trustedConnectionSender } = createConnectionIPC({});
	const frame = { origin: "https://host.example", url: "https://host.example/chat/a" };
	const sender = { mainFrame: frame };
	connectionSenders.set(sender, { origin: "https://host.example", allowLocal: false });
	assert.equal(trustedConnectionSender({ sender, senderFrame: frame }), true);
	assert.equal(trustedConnectionSender({ sender, senderFrame: { ...frame } }), false, "a child frame cannot impersonate the top frame");
	frame.origin = "null";
	assert.equal(trustedConnectionSender({ sender, senderFrame: frame }), false, "a sandboxed frame is not trusted by its displayed URL");
	frame.origin = "https://other.example";
	assert.equal(trustedConnectionSender({ sender, senderFrame: frame }), false);
	connectionSenders.set(sender, { allowLocal: true });
	frame.origin = "file://";
	frame.url = pathToFileURL(join(electronDir, "connection.html")).href + "?error=Offline";
	assert.equal(trustedConnectionSender({ sender, senderFrame: frame }), true);
	frame.url = "file:///tmp/other.html";
	assert.equal(trustedConnectionSender({ sender, senderFrame: frame }), false);
});
