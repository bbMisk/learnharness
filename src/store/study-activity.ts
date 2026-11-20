import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { unionStudySpans, type StudySpan } from "../core/study-activity.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const file = path.join(/* turbopackIgnore: true */ PATHS.data, "study-activity.json");

interface StudyActivity {
	version: 1;
	startedAt: number | null;
	lessons: Record<string, StudySpan[]>;
}

export function readStudyActivity(): StudyActivity {
	try {
		const data = JSON.parse(fs.readFileSync(file, "utf8")) as StudyActivity;
		if (data.version !== 1) throw new Error("Unsupported study activity format");
		return data;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { version: 1, startedAt: null, lessons: {} };
	}
}

function writeStudyActivity(data: StudyActivity): void {
	fs.mkdirSync(PATHS.data, { recursive: true });
	writeFileAtomicSync(file, JSON.stringify(data), { mode: 0o600 });
}

/** Synchronous read/merge/write within the LearnHarness server, like its chat store. */
export function saveStudySpans(chatId: string, spans: StudySpan[]): void {
	const activity = readStudyActivity();
	const previous = Object.hasOwn(activity.lessons, chatId) ? activity.lessons[chatId]! : [];
	const merged = unionStudySpans([...previous, ...spans]);
	const startedAt = Math.min(activity.startedAt ?? Infinity, merged[0]![0]);
	if (startedAt === activity.startedAt && JSON.stringify(merged) === JSON.stringify(previous)) return;
	activity.startedAt = startedAt;
	Object.defineProperty(activity.lessons, chatId, { value: merged, configurable: true, enumerable: true, writable: true });
	writeStudyActivity(activity);
}

export function deleteStudySpans(chatId: string): void {
	const activity = readStudyActivity();
	if (!Object.hasOwn(activity.lessons, chatId)) return;
	delete activity.lessons[chatId];
	writeStudyActivity(activity);
}
