import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
import { appendFilePaths, droppedFilePaths, resolveFilePaths } from "../components/file-drop.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUploadStore } from "../src/store/uploads.ts";
import { Resvg } from "@resvg/resvg-js";
import { readTool } from "../src/agent/tools/read.ts";

it("uploads a memory-backed screenshot on browser and Electron, preserving vision-readable bytes", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "lh-pasted-image-"));
	try {
		const store = createUploadStore(root);
		const bytes = Buffer.from(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>').render().asPng());
		const screenshot = new File([bytes], "image.png", { type: "image/png" });
		const upload = async (file: File) => (await store.save(file.name, file.stream())).path;
		for (const native of [undefined, () => "", () => { throw new Error("Not a disk File"); }]) {
			const paths = await resolveFilePaths([screenshot], native, upload);
			const draft = appendFilePaths("My handwritten solution", paths);
			assert.ok(draft.startsWith("My handwritten solution\n"));
			const imagePath = JSON.parse(draft.split("\n")[1]!);
			const result = await readTool.execute!("pasted-screenshot", { path: imagePath });
			assert.deepEqual(result.content.find((part) => part.type === "image"), { type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
		}
		assert.deepEqual(await resolveFilePaths([screenshot], () => "/local/Finder.png", () => { throw new Error("Must keep existing disk paths"); }), ["/local/Finder.png"]);
		await assert.rejects(resolveFilePaths([screenshot], undefined, async () => { throw new Error("Offline"); }), /Offline/);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("keeps the draft and full paths intact, including spaces, quotes and Unicode", () => {
	const paths = ["/Users/test/My notes.pdf", '/tmp/A "quoted" 文件.txt'];
	const draft = "Teach me from these files:";
	const result = appendFilePaths(draft, paths);
	assert.equal(result.split("\n")[0], draft);
	assert.deepEqual(result.split("\n").slice(1).map((line) => JSON.parse(line)), paths);
	assert.equal(appendFilePaths("unfinished draft", []), "unfinished draft");
	assert.equal(appendFilePaths("draft\n", ["/tmp/a.pdf"]), 'draft\n"/tmp/a.pdf"');
});

it("uses native paths and skips unresolvable files instead of inventing paths from names", () => {
	const files = [new File([], "same.pdf"), new File([], "same.pdf"), new File([], "same.pdf"), new File([], "missing.pdf")];
	const paths = new Map([[files[0], "/one/same.pdf"], [files[1], "/two/same.pdf"], [files[2], "/one/same.pdf"]]);
	assert.deepEqual(droppedFilePaths(files, (file) => paths.get(file) ?? ""), ["/one/same.pdf", "/two/same.pdf"]);
});

it("the real preload delegates only dropped File objects and handles invalid values", () => {
	let bridge: { getPathForFile(file: unknown): string };
	const nativeFile = {};
	runInNewContext(readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8"), {
		process: { platform: "darwin" },
		require: () => ({
			contextBridge: { exposeInMainWorld(_name: string, api: typeof bridge) { bridge = api; } },
			ipcRenderer: { on() {} },
			webUtils: { getPathForFile(file: unknown) {
				if (file !== nativeFile) throw new Error("not a native File");
				return "/Users/test/Full path.pdf";
			} },
		}),
	});
	assert.equal(bridge!.getPathForFile(nativeFile), "/Users/test/Full path.pdf");
	assert.throws(() => bridge!.getPathForFile("/arbitrary/path"), /not a native File/);
	assert.throws(() => bridge!.getPathForFile(null), /not a native File/);
});
