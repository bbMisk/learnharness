import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { it } from "node:test";

it("the connection IPC trusts only the configured top frame or the exact bundled recovery page", () => {
	const file = fileURLToPath(new URL("../electron/main.cjs", import.meta.url));
	const require = createRequire(file);
	const context = {
		URL,
		require: (id: string) => id === "electron" ? { app: { setName() {}, requestSingleInstanceLock: () => false, quit() {} } } : require(id),
		process: { argv: [], env: {}, on() {} },
		__dirname: dirname(file),
	};
	runInNewContext(readFileSync(file, "utf8"), context, { filename: file });
	const frame = { origin: "https://host.example", url: "https://host.example/chat/a" };
	const sender = { mainFrame: frame };
	Object.assign(context, { sender, frame });
	runInNewContext('connectionSenders.set(sender, {origin:"https://host.example", allowLocal:false})', context);
	assert.equal(runInNewContext("trustedConnectionSender({sender,senderFrame:frame})", context), true);
	assert.equal(runInNewContext("trustedConnectionSender({sender,senderFrame:{...frame}})", context), false, "a child frame cannot impersonate the top frame");
	frame.origin = "null";
	assert.equal(runInNewContext("trustedConnectionSender({sender,senderFrame:frame})", context), false, "a sandboxed frame is not trusted by its displayed URL");
	frame.origin = "https://other.example";
	assert.equal(runInNewContext("trustedConnectionSender({sender,senderFrame:frame})", context), false);
	runInNewContext('connectionSenders.set(sender, {allowLocal:true})', context);
	frame.origin = "file://";
	frame.url = pathToFileURL(join(dirname(file), "connection.html")).href + "?error=Offline";
	assert.equal(runInNewContext("trustedConnectionSender({sender,senderFrame:frame})", context), true);
	frame.url = "file:///tmp/other.html";
	assert.equal(runInNewContext("trustedConnectionSender({sender,senderFrame:frame})", context), false);
});
