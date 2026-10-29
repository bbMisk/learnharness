import { reviewSnapshot, ReviewError } from "@/src/server";

async function respond(request?: unknown) {
	try { return Response.json(await reviewSnapshot(request), { headers: { "Cache-Control": "no-store" } }); }
	catch (error) {
		if (error instanceof ReviewError) return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
		console.error("[flashcards] sync failed", error);
		return Response.json({ error: "The host could not save this sync. Pending reviews remain on your device." }, { status: 500, headers: { "Cache-Control": "no-store" } });
	}
}

export async function GET() { return respond(); }

export async function POST(request: Request) {
	const text = await request.text();
	if (text.length > 1_000_000) return Response.json({ error: "Review batch is too large." }, { status: 413 });
	try { return respond(JSON.parse(text)); }
	catch { return Response.json({ error: "Invalid review JSON. No reviews were acknowledged." }, { status: 400 }); }
}
