import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createUploadStore, MAX_UPLOAD_BYTES } from "../src/store/uploads.ts";

it("preserves uploaded bytes, unusual names, and duplicate basenames without overwriting files", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "lh-upload-"));
	try {
		const store = createUploadStore(root); const bytes = new Uint8Array([0, 255, 10, 32]);
		const first = await store.save('../A "quoted" 文件.txt', new Blob([bytes]).stream());
		const second = await store.save('../A "quoted" 文件.txt', new Blob([bytes]).stream());
		assert.notEqual(first.path, second.path); assert.equal(first.name, 'A "quoted" 文件.txt');
		assert.deepEqual(await fs.readFile((await store.read(first.id)).path), Buffer.from(bytes));
		const reserved = await store.save("upload.json", new Blob(["user bytes"]).stream());
		assert.equal(await fs.readFile(reserved.path, "utf8"), "user bytes");
		await assert.rejects(store.read("../outside"));
		await assert.rejects(store.save("huge.pdf", new Blob(["x"]).stream(), String(MAX_UPLOAD_BYTES + 1)), /50 MiB/);
		const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("disconnected")); } });
		await assert.rejects(store.save("partial.txt", broken), /disconnected/);
		assert.equal((await fs.readdir(root)).length, 3);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});
