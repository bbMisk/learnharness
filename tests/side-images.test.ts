import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createUploadStore } from "../src/store/uploads.ts";
import { sideUserContent } from "../src/server/side-images.ts";
import { sideChatResponse } from "../src/server/side-chat.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { uploadedImageReferences, withoutUploadedImagePaths } from "../src/core/upload-images.ts";
import type { ChatRecord } from "../src/core/contracts/chat.ts";

it("delivers actual uploaded screenshot bytes to the side model and preserves the lesson", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "lh-side-images-"));
	try {
		const uploads = createUploadStore(path.join(root, "uploads"));
		const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
		const file = await uploads.save('my "working" 图.png', new Blob([bytes]).stream());
		const text = `Where is my mistake?\n${JSON.stringify(file.path)}`;
		assert.equal(uploadedImageReferences(text).length, 1);
		assert.equal(withoutUploadedImagePaths(text), "Where is my mistake?");
		const faux = createFauxCore({});
		let sawImage = false;
		faux.setResponses([(context) => {
			const content = context.messages.at(-1)!.content;
			assert.ok(Array.isArray(content));
			assert.deepEqual(content.find((part) => part.type === "image"), { type: "image", mimeType: "image/png", data: bytes.toString("base64") });
			sawImage = true;
			return fauxAssistantMessage("I can see your working.");
		}]);
		const chat = { id: "lesson", title: "Lesson", messages: [] } as unknown as ChatRecord;
		const before = JSON.stringify(chat);
		const response = await sideChatResponse(new Request("http://test/side", { method: "POST", body: JSON.stringify({ snapshot: { context: "A lesson", model: { provider: "openai", id: "test" } }, messages: [{ role: "user", content: text }] }) }), "lesson", {
			getChat: () => chat, settings: () => resolveSettings(null), keyPresent: () => true, refresh: async () => {},
			engine: () => ({ model: { ...faux.getModel(), input: ["text", "image"] }, streamFn: faux.streamSimple }),
			userContent: (text) => sideUserContent(text, uploads),
		});
		assert.equal(response.status, 200);
		const frames = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(frames.filter((frame) => frame.type === "delta").map((frame) => frame.text).join(""), "I can see your working.");
		assert.ok(sawImage);
		assert.equal(JSON.stringify(chat), before);
		assert.equal(await sideUserContent("Just text", uploads), "Just text");
		assert.equal(await sideUserContent('"/tmp/private.png"', uploads), '"/tmp/private.png"');
		await assert.rejects(sideUserContent(JSON.stringify(file.path.replace(root, "/unrelated")), uploads), /could not be found/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});
