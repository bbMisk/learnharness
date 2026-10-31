import { uploadStore, UploadError } from "@/src/server";

export const runtime = "nodejs";
export async function POST(request: Request) {
	try {
		const name = new URL(request.url).searchParams.get("name") || "attachment";
		return Response.json(await uploadStore.save(name, request.body, request.headers.get("content-length")), { status: 201 });
	} catch (error) {
		return Response.json(
			{ error: error instanceof Error ? error.message : "Upload failed." },
			{ status: error instanceof UploadError ? error.status : 500 },
		);
	}
}
