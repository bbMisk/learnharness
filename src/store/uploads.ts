import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export class UploadError extends Error { constructor(message: string, public status = 400) { super(message); } }
export interface UploadedFile { id: string; name: string; path: string; size: number; url: string }

/** Upload bytes remain local to this host and feed the existing learner-file tools. */
export function createUploadStore(root: string) {
	return {
		async save(name: string, body: ReadableStream<Uint8Array> | null, length?: string | null): Promise<UploadedFile> {
			if (length && (!Number.isFinite(Number(length)) || Number(length) > MAX_UPLOAD_BYTES)) throw new UploadError("Files can be up to 50 MiB.", 413);
			if (!body) throw new UploadError("Choose a file to upload.");
			name = path.basename(name.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 180);
			if (!name || name === "." || name === "..") name = "attachment";
			const id = randomUUID(); const directory = path.join(root, id); const file = path.join(directory, "file", name);
			await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
			const handle = await fs.open(file, "wx", 0o600); const reader = body.getReader(); let size = 0;
			try {
				for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > MAX_UPLOAD_BYTES) throw new UploadError("Files can be up to 50 MiB.", 413); await handle.writeFile(chunk.value); }
				await handle.sync(); await handle.close();
				const result = { id, name, path: file, size, url: `/api/files/${id}` };
				await fs.writeFile(path.join(directory, "upload.json"), JSON.stringify(result), { mode: 0o600 });
				return result;
			} catch (error) { await reader.cancel().catch(() => {}); await handle.close().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); throw error; }
		},
		async read(id: string): Promise<UploadedFile> {
			if (!/^[0-9a-f-]{36}$/.test(id)) throw new UploadError("File not found.", 404);
			try {
				const record: UploadedFile = JSON.parse(await fs.readFile(path.join(root, id, "upload.json"), "utf8"));
				const directory = await fs.realpath(path.join(root, id)); const file = await fs.realpath(record.path);
				if (!file.startsWith(directory + path.sep)) throw new UploadError("Invalid file path.", 403);
				return { ...record, path: file };
			} catch (error) { if (error instanceof UploadError) throw error; throw new UploadError("File not found.", 404); }
		},
	};
}
export const uploadStore = createUploadStore(path.join(PATHS.data, "uploads"));
