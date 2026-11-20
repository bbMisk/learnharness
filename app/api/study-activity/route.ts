import { STUDY_MAX_AGE_MS, STUDY_MAX_SAMPLE_MS, type StudySpan } from "@/src/core";
import { recordStudyActivity } from "@/src/server";

export async function POST(request: Request) {
	const body = await request.json().catch(() => null);
	const { chatId, spans } = body ?? {};
	const now = Date.now();
	if (
		typeof chatId !== "string" ||
		!/^[A-Za-z0-9_-]+$/.test(chatId) ||
		!Array.isArray(spans) ||
		spans.length === 0 ||
		spans.length > 360 ||
		!spans.every(
			(span): span is StudySpan =>
				Array.isArray(span) &&
				span.length === 2 &&
				span.every(Number.isSafeInteger) &&
				span[0] >= now - STUDY_MAX_AGE_MS &&
				span[1] <= now + STUDY_MAX_SAMPLE_MS &&
				span[1] > span[0] &&
				span[1] - span[0] <= STUDY_MAX_SAMPLE_MS,
		)
	) {
		return Response.json({ error: "Invalid study activity." }, { status: 400 });
	}
	// Clock skew can move a sample slightly ahead. Never credit future time.
	const elapsed = (spans as StudySpan[]).flatMap(([start, end]): StudySpan[] => (start < now ? [[start, Math.min(end, now)]] : []));
	if (!recordStudyActivity(chatId, elapsed)) return Response.json({ error: "Lesson not found." }, { status: 404 });
	return new Response(null, { status: 204 });
}
