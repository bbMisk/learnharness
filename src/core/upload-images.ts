/** Image types attachments can be previewed or sent as. */
export const IMAGE_MIME: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

/** Paths inserted by the shared uploader. UUIDs resolve only in our upload store. */
export function uploadedImageReferences(text: string): { id: string; path: string; url: string }[] {
	const found = new Map<string, { id: string; path: string; url: string }>();
	for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
		let path: unknown;
		try {
			path = JSON.parse(match[0]);
		} catch {
			continue;
		}
		if (typeof path !== "string" || !path.startsWith("/")) continue;
		const id = path.match(/\/uploads\/([0-9a-f-]{36})\/file\/[^/]+\.(?:png|jpe?g|webp|gif)$/i)?.[1];
		if (id) found.set(id, { id, path, url: `/api/files/${id}?preview=1` });
	}
	return [...found.values()];
}

export function withoutUploadedImagePaths(text: string): string {
	for (const image of uploadedImageReferences(text)) text = text.replaceAll(JSON.stringify(image.path), "");
	return text.trim();
}
