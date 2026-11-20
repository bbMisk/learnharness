import { mergeLearningEvents } from "../core/learning-history.ts";
import { estimatedLessonSpans } from "../core/lesson-time.ts";
import { studyDuration, unionStudySpans, type StudySpan } from "../core/study-activity.ts";
import { chatStore } from "../store/chats.ts";
import { readStudyActivity, saveStudySpans } from "../store/study-activity.ts";

const TIMEZONE = "America/New_York";
const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const localHour = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, hour: "2-digit", hourCycle: "h23" });
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// At 05:00 UTC the local time here is either 00:00 or 01:00, including
// on DST transition days. Read the offset at midnight, not at query time.
function midnight(utcDate: number): number {
	const probe = utcDate + 5 * HOUR_MS;
	return probe - Number(localHour.format(probe)) * HOUR_MS;
}

export function recordStudyActivity(chatId: string, spans: StudySpan[]): boolean {
	if (!chatStore.getChat(chatId)) return false;
	if (spans.length) saveStudySpans(chatId, spans);
	return true;
}

export function studyProgress(now = Date.now()) {
	const date = localDate.format(now);
	const utcDate = Date.parse(date + "T00:00:00Z");
	const daysSinceMonday = (new Date(utcDate).getUTCDay() + 6) % 7;
	const weekDate = utcDate - daysSinceMonday * DAY_MS;
	const todayStart = midnight(utcDate);
	const weekStart = midnight(weekDate);
	const activity = readStudyActivity();
	const activeSpans: StudySpan[] = [];
	const estimateSpans: StudySpan[] = [];
	const questionAnswers: number[] = [];
	const completedProblems: number[] = [];

	for (const summary of chatStore.listChats()) {
		const chat = chatStore.getChat(summary.id);
		if (!chat) continue;
		if (Object.hasOwn(activity.lessons, chat.id)) activeSpans.push(...activity.lessons[chat.id]!);
		estimateSpans.push(...estimatedLessonSpans(chat.messages));
		for (const event of mergeLearningEvents(chat.learningEvents, chat.messages)) {
			const at = event.at ? Date.parse(event.at) : NaN;
			if (event.kind === "question-answered" && event.outcome !== "dismissed") questionAnswers.push(at);
			if (event.kind === "practice-concluded") completedProblems.push(at);
		}
	}

	const active = unionStudySpans(activeSpans);
	const estimated = unionStudySpans(estimateSpans);
	const historicalEnd = Math.min(now, activity.startedAt ?? now);
	const period = (from: number) => ({
		activeSeconds: Math.floor(studyDuration(active, from, now) / 1000),
		historicalEstimateSeconds: Math.floor(studyDuration(estimated, from, historicalEnd) / 1000),
		questionsAnswered: questionAnswers.filter((at) => at >= from && at <= now).length,
		practiceProblemsConcluded: completedProblems.filter((at) => at >= from && at <= now).length,
	});
	return {
		timezone: TIMEZONE,
		asOf: new Date(now).toISOString(),
		trackingStartedAt: activity.startedAt === null ? null : new Date(activity.startedAt).toISOString(),
		today: { date, ...period(todayStart) },
		thisWeek: { startDate: new Date(weekDate).toISOString().slice(0, 10), ...period(weekStart) },
		allTime: period(-Infinity),
	};
}
