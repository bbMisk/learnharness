import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { uploadStore, UploadError } from "@/src/server";
import { IMAGE_MIME } from "@/src/core";

export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const file = await uploadStore.read((await params).id);
		const mime =
			new URL(request.url).searchParams.get("preview") === "1" ? IMAGE_MIME[path.extname(file.name).toLowerCase()] : undefined;
		return new Response(Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>, {
			headers: {
				"Content-Type": mime || "application/octet-stream",
				"Content-Length": String(file.size),
				"Cache-Control": "private, no-store",
				"X-Content-Type-Options": "nosniff",
				"Content-Disposition": `${mime ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
			},
		});
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "File not found." },
			{ status: error instanceof UploadError ? error.status : 500 },
		);
	}
}
