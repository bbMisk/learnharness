import { checkTypeWhisperRequest, typeWhisper, isTypeWhisperError } from "@/src/server";

export const dynamic = "force-dynamic";
function failure(error: unknown) {
	return Response.json(
		{ message: isTypeWhisperError(error) ? error.message : "TypeWhisper request failed." },
		{ status: isTypeWhisperError(error) ? error.status : 503, headers: { "Cache-Control": "no-store" } },
	);
}
export async function GET(request: Request) {
	try {
		checkTypeWhisperRequest(request);
		return Response.json(await typeWhisper.session(new URL(request.url).searchParams.get("id") ?? ""), {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		return failure(error);
	}
}
export async function POST(request: Request) {
	try {
		checkTypeWhisperRequest(request);
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== "object") return Response.json({ message: "Invalid TypeWhisper action." }, { status: 400 });
		if (body.action === "start") return Response.json(await typeWhisper.start());
		if (body.action === "stop" && typeof body.id === "string") return Response.json(await typeWhisper.stop(body.id));
		return Response.json({ message: "Invalid TypeWhisper action." }, { status: 400 });
	} catch (error) {
		return failure(error);
	}
}
