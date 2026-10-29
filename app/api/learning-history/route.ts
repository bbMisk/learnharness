import { learningHistory, captureLearningHistory } from "@/src/server";

/** Portable raw history; scheduler state and model credentials are excluded. */
export async function GET(request: Request) {
	const url = new URL(request.url);
	const history = learningHistory(url.searchParams.get("chatId"));
	if (!history) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json(history, { headers: {
		"Cache-Control": "no-store",
		...(url.searchParams.get("download") === "1" ? { "Content-Disposition": 'attachment; filename="learnharness-learning-history.json"' } : {}),
	} });
}

export async function POST() {
	return Response.json(captureLearningHistory());
}
