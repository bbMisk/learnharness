import fs from "node:fs/promises";
import path from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { uploadStore } from "../store/uploads.ts";
import { uploadedImageReferences, withoutUploadedImagePaths } from "../core/upload-images.ts";

const MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

/** Side tutors have no file tools: resolve explicitly attached, host-owned images before inference. */
export async function sideUserContent(text: string, uploads = uploadStore): Promise<string | (TextContent | ImageContent)[]> {
	const refs = uploadedImageReferences(text);
	if (!refs.length) return text;
	const images: ImageContent[] = [];
	for (const ref of refs) {
		const file = await uploads.read(ref.id);
		if (file.path !== (await fs.realpath(ref.path).catch(() => "")))
			throw new Error("The screenshot attachment could not be found. Paste it again.");
		const mimeType = MIME[path.extname(file.name).toLowerCase()];
		if (!mimeType) throw new Error("The side tutor supports PNG, JPEG, WebP and GIF images.");
		images.push({ type: "image", mimeType, data: (await fs.readFile(file.path)).toString("base64") });
	}
	return [{ type: "text", text: withoutUploadedImagePaths(text) || "Please help me understand this screenshot." }, ...images];
}
