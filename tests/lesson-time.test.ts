/**
 * Time spent on a lesson (owner, 2026-11-05 — src/core/lesson-time.ts):
 * the record-only measurement (breaks, the open question/problem threshold,
 * ordering, empty and single-event records), the sidebar's rounding and
 * wording, the General switch (default off, strict writes, round trip), and
 * the chat list: projected once per record change and sent on every row;
 * the switch only decides whether the sidebar shows it. Temp data dir; no network.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lesson-time-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.mkdirSync(process.env.LH_DATA_DIR, { recursive: true });
const { lessonTimeMs, formatLessonTime, BREAK_AFTER_MS, OPEN_BREAK_AFTER_MS } = await import("../src/core/lesson-time.ts");
const { QUESTION_TOOLS } = await import("../src/core/pending.ts");
const { FACTORY_SETTINGS, sanitizeUserSettings } = await import("../src/core/settings.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");
const { parseGeneralSettingsBody } = await import("../src/server/settings-body.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { PATHS } = await import("../config.ts");
const listing = await import("../app/api/chats/route.ts");
const settingsSection = await import("../app/api/settings/[section]/route.ts");
const settingsRoute = await import("../app/api/settings/route.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const MIN = 60_000;
let n = 0;
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(t: number): LhMessage {
	return { id: `u${++n}`, role: "user", content: "hi", timestamp: t };
}
function assistant(
	t: number,
	calls: Array<{ id: string; name: string }> = [],
	stopReason: "stop" | "toolUse" | "error" | "aborted" = calls.length ? "toolUse" : "stop",
): LhMessage {
	return {
		id: `a${++n}`,
		role: "assistant",
		content: [
			{ type: "text", text: "ok" },
			...calls.map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: {} })),
		],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage,
		stopReason,
		timestamp: t,
	} as LhMessage;
}
function result(t: number, toolCallId: string, toolName: string, details: unknown = { ok: true }, isError = false): LhMessage {
	return {
		id: `r${++n}`,
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		details,
		isError,
		timestamp: t,
	} as LhMessage;
}
function marker(t: number): LhMessage {
	return { id: `c${++n}`, role: "custom", customType: "subagent-steer", content: "", display: true, details: null, timestamp: t };
}

describe("lessonTimeMs", () => {
	it("an empty record and a single message have no measurable time", () => {
		assert.equal(lessonTimeMs([]), 0);
		assert.equal(lessonTimeMs([user(5 * MIN)]), 0);
		assert.equal(lessonTimeMs([assistant(5 * MIN)]), 0);
	});

	it("sums the gaps between every timestamped message kind, nothing before the first or after the last", () => {
		const record = [user(100 * MIN), assistant(101 * MIN), result(103 * MIN, "x", "research"), marker(106 * MIN), user(110 * MIN)];
		assert.equal(lessonTimeMs(record), 10 * MIN);
	});

	it("a gap longer than 10 minutes while nothing is open is a break and counts nothing", () => {
		assert.equal(BREAK_AFTER_MS, 10 * MIN);
		assert.equal(lessonTimeMs([user(0), assistant(9 * MIN)]), 9 * MIN);
		assert.equal(lessonTimeMs([user(0), assistant(10 * MIN)]), 10 * MIN);
		assert.equal(lessonTimeMs([user(0), assistant(11 * MIN)]), 0);
		assert.equal(lessonTimeMs([user(0), assistant(3 * MIN), user(3 * 60 * MIN)]), 3 * MIN, "a three-hour break adds nothing");
	});

	it("allows 25 minutes of thinking while a question waits; longer is a break", () => {
		assert.equal(OPEN_BREAK_AFTER_MS, 25 * MIN);
		const quiz = { id: "q1", name: "quiz" };
		assert.equal(
			lessonTimeMs([user(0), assistant(1 * MIN, [quiz]), result(21 * MIN, "q1", "quiz")]),
			21 * MIN,
			"20 minutes thinking counts in full",
		);
		assert.equal(
			lessonTimeMs([user(0), assistant(1 * MIN, [quiz]), result(61 * MIN, "q1", "quiz")]),
			1 * MIN,
			"an hour away counts nothing",
		);
		// Answered: the next gap is back under the normal threshold.
		assert.equal(lessonTimeMs([assistant(0, [quiz]), result(20 * MIN, "q1", "quiz"), user(40 * MIN)]), 20 * MIN);
	});

	it("every question tool opens a question; other tool calls do not", () => {
		for (const name of QUESTION_TOOLS) {
			assert.equal(lessonTimeMs([assistant(0, [{ id: "q", name }]), result(20 * MIN, "q", name)]), 20 * MIN, name);
		}
		assert.equal(lessonTimeMs([assistant(0, [{ id: "j", name: "research" }]), result(20 * MIN, "j", "research")]), 0);
	});

	it("an error result, a dismissal or any other result closes the question", () => {
		const record = [
			assistant(0, [{ id: "q", name: "ask_user_question" }]),
			result(2 * MIN, "q", "ask_user_question", { dismissed: true }, true),
			user(22 * MIN),
		];
		assert.equal(lessonTimeMs(record), 2 * MIN);
	});

	it("a failed or aborted generation poses no question", () => {
		for (const stop of ["error", "aborted"] as const) {
			assert.equal(lessonTimeMs([assistant(0, [{ id: "q", name: "quiz" }], stop), user(20 * MIN)]), 0, stop);
		}
	});

	it("a newer assistant message leaves an older unanswered question closed (the question gate's rule)", () => {
		const record = [assistant(0, [{ id: "q", name: "quiz" }]), user(2 * MIN), assistant(3 * MIN), user(23 * MIN)];
		assert.equal(lessonTimeMs(record), 3 * MIN);
	});

	it("parallel questions stay open until the last one is answered", () => {
		const record = [
			assistant(0, [
				{ id: "q1", name: "quiz" },
				{ id: "q2", name: "quiz" },
			]),
			result(20 * MIN, "q1", "quiz"),
			result(40 * MIN, "q2", "quiz"),
			user(60 * MIN),
		];
		assert.equal(lessonTimeMs(record), 20 * MIN + 20 * MIN);
	});

	it("allows 25 minutes while a cram problem is started and not done; longer is a break", () => {
		const list = {
			ok: true,
			problems: [
				{ id: "q1", label: "Q1" },
				{ id: "q2", label: "Q2" },
			],
		};
		const record = [
			result(0, "l", "problem_list", list),
			result(1 * MIN, "s1", "problem_start", { ok: true, id: "q1" }),
			user(21 * MIN), // 20: open
			assistant(51 * MIN), // 30: still open, a break
			result(52 * MIN, "d1", "problem_done", { ok: true, id: "q1", outcome: "correct" }),
			user(72 * MIN), // 20: done, a break
		];
		assert.equal(lessonTimeMs(record), 1 * MIN + 20 * MIN + 1 * MIN);
	});

	it("a failed problem_start opens nothing; a re-list that drops the started problem closes it", () => {
		const list = { ok: true, problems: [{ id: "q1", label: "Q1" }] };
		assert.equal(
			lessonTimeMs([result(0, "l", "problem_list", list), result(0, "s", "problem_start", { ok: false }, true), user(20 * MIN)]),
			0,
		);
		const relist = { ok: true, problems: [{ id: "q2", label: "Q2" }] };
		assert.equal(
			lessonTimeMs([
				result(0, "l", "problem_list", list),
				result(0, "s", "problem_start", { ok: true, id: "q1" }),
				result(0, "l2", "problem_list", relist),
				user(20 * MIN),
			]),
			0,
		);
	});

	it("an out-of-order message adds nothing, and the next gap runs from the latest time", () => {
		assert.equal(lessonTimeMs([user(10 * MIN), user(5 * MIN)]), 0, "a negative gap counts 0");
		assert.equal(lessonTimeMs([user(0), user(6 * MIN), user(3 * MIN), user(8 * MIN)]), 8 * MIN, "never more than the span");
		assert.equal(lessonTimeMs([user(0), user(0), user(0)]), 0, "equal timestamps add nothing");
	});

	it("messages without a usable timestamp are skipped for timing", () => {
		const broken = { ...user(0), timestamp: Number.NaN } as LhMessage;
		const missing = { ...user(0) } as Record<string, unknown>;
		delete missing.timestamp;
		assert.equal(lessonTimeMs([user(0), broken, missing as unknown as LhMessage, user(4 * MIN)]), 4 * MIN);
		assert.equal(lessonTimeMs([broken, user(4 * MIN)]), 0, "the first usable timestamp starts the clock");
	});

	it("an untimed message still updates what is open", () => {
		const untimedAnswer = { ...result(0, "q", "quiz"), timestamp: undefined } as unknown as LhMessage;
		// The untimed answer closes the question, so the 20-minute gap is a break.
		assert.equal(lessonTimeMs([assistant(0, [{ id: "q", name: "quiz" }]), untimedAnswer, user(20 * MIN)]), 0);
	});
});

describe("formatLessonTime", () => {
	it("shows nothing for a lesson with no measurable time", () => {
		for (const value of [0, -MIN, Number.NaN, Number.POSITIVE_INFINITY, undefined, null])
			assert.equal(formatLessonTime(value), null, String(value));
	});

	it("rounds to the nearest 10 minutes; under 5 minutes reads <10m", () => {
		const cases: Array<[number, string]> = [
			[1, "<10m"],
			[4 * MIN + 59_999, "<10m"],
			[5 * MIN, "10m"],
			[14 * MIN, "10m"],
			[15 * MIN, "20m"],
			[50 * MIN, "50m"],
			[54 * MIN, "50m"],
			[55 * MIN, "1h"],
			[60 * MIN, "1h"],
			[80 * MIN, "1h 20m"],
			[120 * MIN, "2h"],
			[12 * 60 * MIN + 36 * MIN, "12h 40m"],
			[12 * 60 * MIN + 40 * MIN, "12h 40m"],
		];
		for (const [ms, text] of cases) assert.equal(formatLessonTime(ms), text, `${ms}ms`);
	});
});

describe("the General switch", () => {
	it("is off by default", () => {
		assert.equal(FACTORY_SETTINGS.general.showLessonTime, false);
		assert.equal(resolveSettings(null).general.showLessonTime, false);
		assert.equal(resolveSettings({ version: 1, general: {} }).general.showLessonTime, false);
		assert.equal(resolveSettings({ version: 1, general: { showLessonTime: true } }).general.showLessonTime, true);
	});

	it("writes strictly and reads leniently", () => {
		assert.deepEqual(parseGeneralSettingsBody({ showLessonTime: true }), { ok: true, settings: { showLessonTime: true } });
		assert.deepEqual(parseGeneralSettingsBody({ showLessonTime: false }), { ok: true, settings: { showLessonTime: false } });
		assert.deepEqual(parseGeneralSettingsBody({ showLessonTime: "yes" }), { ok: false, error: "showLessonTime must be a boolean" });
		assert.deepEqual(sanitizeUserSettings({ version: 1, general: { showLessonTime: true } })?.general, { showLessonTime: true });
		assert.deepEqual(sanitizeUserSettings({ version: 1, general: { showLessonTime: 1 } })?.general, {});
	});
});

const put = (general: unknown) =>
	settingsSection.PUT(new Request("http://test/api/settings/general", { method: "PUT", body: JSON.stringify(general) }), {
		params: Promise.resolve({ section: "general" }),
	});
const listed = async () =>
	(await (await listing.GET(new Request("http://test/api/chats"))).json()).chats as Array<{ id: string; timeSpentMs?: number }>;

describe("the chat list", () => {
	it("projects time spent with the summary and sends it on every row; the switch round-trips", async () => {
		const chat = chatStore.createChat("Timed lesson");
		chatStore.saveMessages(chat.id, [
			user(0),
			assistant(1 * MIN, [{ id: "q", name: "quiz" }]),
			result(21 * MIN, "q", "quiz"),
			user(41 * MIN),
		]);
		assert.equal(chatStore.listChats().find((c) => c.id === chat.id)?.timeSpentMs, 21 * MIN, "1 + 20 thinking; the last 20-minute gap is a break");

		assert.equal((await listed()).find((c) => c.id === chat.id)?.timeSpentMs, 21 * MIN, "sent with the switch off too");
		assert.equal((await put({ showLessonTime: true })).status, 200);
		const saved = (await (await settingsRoute.GET()).json()).settings;
		assert.equal(saved.general.showLessonTime, true, "the switch round-trips");
		assert.equal((await put({ showLessonTime: "on" })).status, 400);
	});

	it("measures a record written before the field existed, and follows its next write", async () => {
		const id = "chat_legacy_time";
		const file = path.join(PATHS.chats, `${id}.json`);
		fs.mkdirSync(PATHS.chats, { recursive: true });
		const legacy = {
			id,
			title: "Old lesson",
			createdAt: "2026-10-01T00:00:00.000Z",
			updatedAt: "2026-10-01T00:00:00.000Z",
			messages: [user(0), assistant(4 * MIN)],
		};
		fs.writeFileSync(file, JSON.stringify(legacy));
		assert.equal(chatStore.listChats().find((c) => c.id === id)?.timeSpentMs, 4 * MIN);
		chatStore.saveMessages(id, [...legacy.messages, user(10 * MIN)]);
		assert.equal(chatStore.listChats().find((c) => c.id === id)?.timeSpentMs, 10 * MIN);
	});
});
