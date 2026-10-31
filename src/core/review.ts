import type { ReviewEngine, ReviewMemory } from "./review-engine.ts";

export const REVIEW_PROTOCOL = 1;
export const NEW_CARDS_PER_DAY = 20;
export const UNASSIGNED_REVIEW_PROJECT = "__unassigned";
export interface ReviewProject {
	id: string;
	name: string;
}
export type ReviewRating = 1 | 2 | 3 | 4;
export type ReviewMode = "mcq" | "recall";
export interface ReviewQuestion {
	prompt: string;
	options: string[];
	correctIndex: number;
	explanation: string;
}
export interface Flashcard {
	mcq?: ReviewQuestion;
	id: string;
	sourceNodeId: string;
	revision: string;
	front: string;
	back: string;
	deckId: string;
	deckName: string;
	/** All projects whose chats supplied this concept; absent on older snapshots. */
	projectIds?: string[];
	createdAt: number;
	active: boolean;
}
export interface CardSchedule {
	mode?: ReviewMode;
	mcqStreak?: number;
	mcqFirstDay?: number | null;
	phase: "new" | "learning" | "review" | "relearning";
	step: number;
	memory: ReviewMemory | null;
	dueAt: number;
	lastReviewAt: number | null;
	intervalDays: number;
	reps: number;
	lapses: number;
	introducedDay: number | null;
}
export interface ReviewAttempt {
	mode?: ReviewMode;
	selectedIndex?: number;
	id: string;
	deviceId: string;
	sequence: number;
	cardId: string;
	cardRevision: string;
	rating: ReviewRating;
	clientAt: number;
	shownAt: number;
	revealedAt: number;
	foregroundMs: number;
	engineId: string;
	deviceAt?: number;
	clockOffsetMs?: number;
}
export interface StoredReview extends ReviewAttempt {
	receivedAt: number;
	effectiveAt: number;
	timeAdjusted: boolean;
}
export interface DeviceReceipt {
	through: number;
	extra: number[];
}
export interface ReviewSnapshot {
	version: 1;
	collectionId: string;
	revision: number;
	engineId: string;
	serverAt: number;
	cards: Array<Flashcard & { schedule: CardSchedule }>;
	projects?: ReviewProject[];
	receipts: Record<string, DeviceReceipt>;
}
export interface ReviewRequest {
	version: 1;
	deviceId: string;
	attempts: ReviewAttempt[];
}

const DAY = 86400000;
const localTime = new Intl.DateTimeFormat("en-US", {
	timeZone: "America/New_York",
	year: "numeric",
	month: "numeric",
	day: "numeric",
	hour: "numeric",
	minute: "numeric",
	second: "numeric",
	hourCycle: "h23",
});
function localParts(at: number): Record<string, number> {
	return Object.fromEntries(
		localTime
			.formatToParts(at)
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, Number(part.value)]),
	);
}

/** Anki-style day boundary, kept stable when either device changes timezone. */
export function studyDay(at: number): number {
	const p = localParts(at);
	return Date.UTC(p.year!, p.month! - 1, p.day!) / DAY - (p.hour! < 4 ? 1 : 0);
}

export function dueOnStudyDay(at: number, days: number): number {
	const target = (studyDay(at) + days) * DAY + 4 * 3600000;
	let guess = target;
	for (let i = 0; i < 3; i++) {
		const p = localParts(guess);
		guess += target - Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
	}
	return guess;
}
export function newCardSchedule(): CardSchedule {
	return { phase: "new", step: 0, memory: null, dueAt: 0, lastReviewAt: null, intervalDays: 0, reps: 0, lapses: 0, introducedDay: null };
}

/** Anki's passing-interval floor, with fuzz disabled for reproducible offline replay.
 * Source: Anki 26.09.3 states/fuzz.rs (AGPL-3.0-or-later). */
function passingMinimum(interval: number, previous: number): number {
	let delta = interval < 2.5 ? 0 : 1;
	if (delta)
		for (const [start, end, factor] of [
			[2.5, 7, 0.15],
			[7, 20, 0.1],
			[20, Number.MAX_VALUE, 0.05],
		]) {
			delta = Math.fround(delta + Math.fround(factor! * Math.max(0, Math.fround(Math.min(interval, end!) - start!))));
		}
	return Math.round(interval) > previous ? previous + 1 : previous <= Math.round(Math.fround(interval + delta)) ? previous : 0;
}

export function reviewChoices(state: CardSchedule, at: number, engine: ReviewEngine): Record<ReviewRating, CardSchedule> {
	at = Math.max(at, state.lastReviewAt ?? at);
	const elapsed = state.lastReviewAt === null ? 0 : Math.max(0, studyDay(at) - studyDay(state.lastReviewAt));
	const next = engine.nextStates(state.memory, elapsed);
	const cap = (interval: number, minimum = 1) => Math.min(36500, Math.max(Math.min(36500, minimum), Math.round(interval), 1));
	let hardDays = cap(next.hard.interval);
	let goodDays = cap(next.good.interval);
	let easyDays = cap(next.easy.interval, goodDays + 1);
	if (state.phase === "review") {
		hardDays = cap(next.hard.interval, passingMinimum(next.hard.interval, state.intervalDays));
		goodDays = cap(next.good.interval, Math.max(hardDays + 1, passingMinimum(next.good.interval, state.intervalDays)));
		easyDays = cap(next.easy.interval, Math.max(goodDays + 1, passingMinimum(next.easy.interval, state.intervalDays)));
	}
	const choices = {} as Record<ReviewRating, CardSchedule>;
	for (const rating of [1, 2, 3, 4] as const) {
		const item = next[(["again", "hard", "good", "easy"] as const)[rating - 1]!];
		let phase: CardSchedule["phase"] = "review";
		let step = 0;
		let delay = 0;
		let intervalDays = rating === 1 ? cap(item.interval) : rating === 2 ? hardDays : rating === 3 ? goodDays : easyDays;
		if (state.phase === "new" || state.phase === "learning") {
			if (rating === 1) {
				phase = "learning";
				delay = 60000;
			}
			if (rating === 2) {
				phase = "learning";
				step = state.step;
				delay = state.step === 0 ? 330000 : 600000;
			}
			if (rating === 3 && state.step === 0) {
				phase = "learning";
				step = 1;
				delay = 600000;
			}
		} else if (rating === 1 || (state.phase === "relearning" && rating === 2)) {
			phase = "relearning";
			delay = rating === 1 ? 600000 : 900000;
		}
		if (phase === "learning") intervalDays = 0;
		choices[rating] = {
			...(state.mode ? { mode: state.mode, mcqStreak: state.mcqStreak, mcqFirstDay: state.mcqFirstDay } : {}),
			phase,
			step,
			memory: item.memory,
			intervalDays,
			dueAt: delay ? at + delay : dueOnStudyDay(at, intervalDays),
			lastReviewAt: at,
			reps: state.reps + 1,
			lapses: state.lapses + (state.phase === "review" && rating === 1 ? 1 : 0),
			introducedDay: state.introducedDay ?? studyDay(at),
		};
	}
	return choices;
}

/** Legacy histories are recall histories; untouched cards begin with recognition. */
export function reviewMode(state: CardSchedule): ReviewMode {
	return state.mode ?? (state.reps > 0 ? "recall" : "mcq");
}

/** One FSRS memory and one history for both response formats. Recognition
 * intervals stay short until the learner demonstrates recall without choices. */
export function applyReview(
	state: CardSchedule,
	attempt: Pick<ReviewAttempt, "rating" | "mode">,
	at: number,
	engine: ReviewEngine,
): CardSchedule {
	const next = reviewChoices(state, at, engine)[attempt.rating];
	if (attempt.mode !== "mcq" || reviewMode(state) === "recall") return next;
	const passed = attempt.rating === 3;
	const scheduled = state.reps === 0 || at >= state.dueAt;
	const streak = passed ? (state.mcqStreak ?? 0) + Number(scheduled) : 0;
	const firstDay = passed ? (state.mcqFirstDay ?? studyDay(at)) : null;
	const graduated = streak >= 3 && firstDay !== null && studyDay(at) > firstDay;
	const dueAt = Math.min(next.dueAt, dueOnStudyDay(at, 1));
	return {
		...next,
		mode: graduated ? "recall" : "mcq",
		mcqStreak: streak,
		mcqFirstDay: firstDay,
		dueAt,
		intervalDays: Math.min(next.intervalDays, 1),
	};
}

export function assertReviewQuestion(value: unknown): asserts value is ReviewQuestion {
	const q = objectOf(value);
	if (
		!q ||
		typeof q.prompt !== "string" ||
		!q.prompt.trim() ||
		q.prompt.length > 4000 ||
		!Array.isArray(q.options) ||
		q.options.length !== 4 ||
		!q.options.every((v) => typeof v === "string" && v.trim() && v.length <= 4000) ||
		new Set(q.options.map((v) => (v as string).trim().toLowerCase())).size !== 4 ||
		!Number.isInteger(q.correctIndex) ||
		(q.correctIndex as number) < 0 ||
		(q.correctIndex as number) > 3 ||
		typeof q.explanation !== "string" ||
		!q.explanation.trim() ||
		q.explanation.length > 8000
	)
		throw new ReviewError("The multiple-choice question is invalid. No review was saved.");
}

export function deviceReceipts(attempts: readonly Pick<ReviewAttempt, "deviceId" | "sequence">[]): Record<string, DeviceReceipt> {
	const devices = new Map<string, Set<number>>();
	for (const attempt of attempts) {
		let sequences = devices.get(attempt.deviceId);
		if (!sequences) {
			sequences = new Set();
			devices.set(attempt.deviceId, sequences);
		}
		sequences.add(attempt.sequence);
	}
	return Object.fromEntries(
		[...devices].map(([id, sequences]) => {
			let through = 0;
			while (sequences.has(through + 1)) through++;
			return [id, { through, extra: [...sequences].filter((sequence) => sequence > through).sort((a, b) => a - b) }];
		}),
	);
}

export function isReceipted(attempt: ReviewAttempt, receipts: Record<string, DeviceReceipt>): boolean {
	const receipt = receipts[attempt.deviceId];
	return !!receipt && (attempt.sequence <= receipt.through || receipt.extra.includes(attempt.sequence));
}

export function compareReviews(
	a: Pick<StoredReview, "effectiveAt" | "deviceId" | "sequence" | "id">,
	b: Pick<StoredReview, "effectiveAt" | "deviceId" | "sequence" | "id">,
): number {
	return a.effectiveAt - b.effectiveAt || a.deviceId.localeCompare(b.deviceId) || a.sequence - b.sequence || a.id.localeCompare(b.id);
}

export function replayCard(attempts: readonly StoredReview[], engine: ReviewEngine): CardSchedule {
	return [...attempts]
		.sort(compareReviews)
		.reduce((state, review) => applyReview(state, review, review.effectiveAt, engine), newCardSchedule());
}

export class ReviewError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 409 | 426 = 400,
	) {
		super(message);
		this.name = "ReviewError";
	}
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const token = /^[A-Za-z0-9_.-]{1,128}$/;
const objectOf = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const time = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;

export function validateReviewRequest(value: unknown): ReviewRequest {
	const request = objectOf(value);
	if (request?.version !== REVIEW_PROTOCOL)
		throw new ReviewError("A newer flashcard app is required. Reconnect and reload; queued reviews are preserved.", 426);
	if (
		typeof request.deviceId !== "string" ||
		!uuid.test(request.deviceId) ||
		!Array.isArray(request.attempts) ||
		request.attempts.length > 200
	)
		throw new ReviewError("Invalid device or review batch (maximum 200 attempts).");
	const deviceId = request.deviceId.toLowerCase();
	const attempts = request.attempts.map((value) => {
		const a = objectOf(value);
		if (
			!a ||
			typeof a.id !== "string" ||
			!uuid.test(a.id) ||
			typeof a.deviceId !== "string" ||
			a.deviceId.toLowerCase() !== deviceId ||
			!Number.isSafeInteger(a.sequence) ||
			(a.sequence as number) < 1 ||
			(a.sequence as number) > 1_000_000_000 ||
			(a.mode !== undefined && a.mode !== "mcq" && a.mode !== "recall") ||
			(a.mode === "mcq" &&
				(![1, 3].includes(a.rating as number) ||
					!Number.isInteger(a.selectedIndex) ||
					(a.selectedIndex as number) < 0 ||
					(a.selectedIndex as number) > 3)) ||
			(a.mode !== "mcq" && a.selectedIndex !== undefined) ||
			!([1, 2, 3, 4] as unknown[]).includes(a.rating) ||
			typeof a.cardId !== "string" ||
			!token.test(a.cardId) ||
			typeof a.cardRevision !== "string" ||
			!token.test(a.cardRevision) ||
			typeof a.engineId !== "string" ||
			!token.test(a.engineId) ||
			!time(a.clientAt) ||
			!time(a.shownAt) ||
			!time(a.revealedAt) ||
			!time(a.foregroundMs) ||
			a.foregroundMs > 7 * DAY ||
			(a.deviceAt !== undefined && !time(a.deviceAt)) ||
			(a.clockOffsetMs !== undefined && (typeof a.clockOffsetMs !== "number" || !Number.isFinite(a.clockOffsetMs)))
		)
			throw new ReviewError("Invalid review attempt. No reviews were acknowledged.");
		return {
			id: a.id.toLowerCase(),
			deviceId,
			sequence: a.sequence as number,
			cardId: a.cardId,
			cardRevision: a.cardRevision,
			...(a.mode !== undefined ? { mode: a.mode as ReviewMode } : {}),
			...(a.selectedIndex !== undefined ? { selectedIndex: a.selectedIndex as number } : {}),
			rating: a.rating as ReviewRating,
			clientAt: a.clientAt,
			shownAt: a.shownAt,
			revealedAt: a.revealedAt,
			foregroundMs: a.foregroundMs,
			engineId: a.engineId,
			...(a.deviceAt !== undefined ? { deviceAt: a.deviceAt } : {}),
			...(a.clockOffsetMs !== undefined ? { clockOffsetMs: a.clockOffsetMs as number } : {}),
		};
	});
	return { version: 1, deviceId, attempts };
}

export function scheduleToken(card: Flashcard & { schedule: CardSchedule }): string {
	return JSON.stringify([card.id, card.revision, card.schedule]);
}

/** Pending ratings are provisional until the host merges all device histories. */
export function localReviewCards(
	snapshot: ReviewSnapshot,
	pending: readonly ReviewAttempt[],
	engine: ReviewEngine,
): ReviewSnapshot["cards"] {
	const cards = snapshot.cards.map((card) => ({ ...card }));
	const byId = new Map(cards.map((card) => [card.id, card]));
	for (const attempt of [...pending]
		.filter((attempt) => !isReceipted(attempt, snapshot.receipts))
		.sort((a, b) => a.clientAt - b.clientAt || a.sequence - b.sequence || a.id.localeCompare(b.id))) {
		const card = byId.get(attempt.cardId);
		if (card) card.schedule = applyReview(card.schedule, attempt, Math.max(card.createdAt, attempt.clientAt), engine);
	}
	return cards;
}

export function cardProjectIds(card: Pick<Flashcard, "projectIds">): string[] {
	return card.projectIds?.length ? [...new Set(card.projectIds)] : [UNASSIGNED_REVIEW_PROJECT];
}

export function reviewQueue(cards: ReviewSnapshot["cards"], now: number, selection: string | { projectIds?: readonly string[] } = "") {
	const today = studyDay(now);
	const introduced = new Map<string, number>();
	for (const card of cards.filter((card) => card.schedule.introducedDay === today)) {
		for (const id of cardProjectIds(card)) introduced.set(id, (introduced.get(id) ?? 0) + 1);
	}
	const projectIds = typeof selection === "string" ? undefined : selection.projectIds;
	const selected = cards.filter(
		(card) =>
			card.active &&
			(typeof selection === "string"
				? !selection || card.deckId === selection
				: !projectIds?.length || cardProjectIds(card).some((id) => projectIds.includes(id))),
	);
	const groups = new Set(projectIds?.length ? projectIds : selected.flatMap(cardProjectIds));
	const newRemaining = [...groups].reduce((sum, id) => sum + Math.max(0, NEW_CARDS_PER_DAY - (introduced.get(id) ?? 0)), 0);
	const due = selected
		.filter((card) => card.schedule.reps > 0 && card.schedule.dueAt <= now)
		.sort(
			(a, b) =>
				Number(b.schedule.phase !== "review") - Number(a.schedule.phase !== "review") ||
				a.schedule.dueAt - b.schedule.dueAt ||
				a.id.localeCompare(b.id),
		);
	const used = new Map(introduced),
		fresh: typeof selected = [];
	for (const card of selected.filter((card) => card.schedule.reps === 0)) {
		const ids = cardProjectIds(card);
		if (ids.some((id) => (used.get(id) ?? 0) >= NEW_CARDS_PER_DAY)) continue;
		fresh.push(card);
		for (const id of ids) used.set(id, (used.get(id) ?? 0) + 1);
	}
	return {
		selected,
		due,
		fresh,
		queue: [...due, ...fresh],
		newRemaining,
		nextDueAt: Math.min(
			...selected.filter((card) => card.schedule.reps > 0 && card.schedule.dueAt > now).map((card) => card.schedule.dueAt),
		),
	};
}

export function assertReviewSnapshot(value: unknown): asserts value is ReviewSnapshot {
	const snapshot = objectOf(value);
	if (snapshot?.version !== 1)
		throw new ReviewError("This flashcard data version needs an app update. Queued reviews remain saved.", 426);
	if (
		typeof snapshot.collectionId !== "string" ||
		!token.test(snapshot.collectionId) ||
		!Number.isSafeInteger(snapshot.revision) ||
		(snapshot.revision as number) < 0 ||
		typeof snapshot.engineId !== "string" ||
		!time(snapshot.serverAt) ||
		!Array.isArray(snapshot.cards) ||
		!objectOf(snapshot.receipts)
	)
		throw new ReviewError("The host returned invalid flashcard data.");
	const ids = new Set<string>();
	for (const value of snapshot.cards) {
		const card = objectOf(value),
			state = objectOf(card?.schedule),
			memory = objectOf(state?.memory);
		if (
			!card ||
			typeof card.id !== "string" ||
			!token.test(card.id) ||
			ids.has(card.id) ||
			typeof card.revision !== "string" ||
			!token.test(card.revision) ||
			typeof card.front !== "string" ||
			typeof card.back !== "string" ||
			typeof card.deckId !== "string" ||
			typeof card.deckName !== "string" ||
			typeof card.active !== "boolean" ||
			!time(card.createdAt) ||
			!state ||
			!["new", "learning", "review", "relearning"].includes(state.phase as string) ||
			!time(state.dueAt) ||
			(state.lastReviewAt !== null && !time(state.lastReviewAt)) ||
			!Number.isSafeInteger(state.reps) ||
			(state.reps as number) < 0 ||
			!Number.isSafeInteger(state.lapses) ||
			(state.lapses as number) < 0 ||
			!Number.isSafeInteger(state.step) ||
			(state.step as number) < 0 ||
			!Number.isSafeInteger(state.intervalDays) ||
			(state.intervalDays as number) < 0 ||
			(state.introducedDay !== null && !Number.isSafeInteger(state.introducedDay)) ||
			(state.memory !== null &&
				(!memory ||
					typeof memory.stability !== "number" ||
					!Number.isFinite(memory.stability) ||
					memory.stability <= 0 ||
					typeof memory.difficulty !== "number" ||
					!Number.isFinite(memory.difficulty)))
		)
			throw new ReviewError("The host returned an invalid card. Existing local data was preserved.");
		if (card.mcq !== undefined) assertReviewQuestion(card.mcq);
		if (state.mode !== undefined && state.mode !== "mcq" && state.mode !== "recall") throw new ReviewError("Invalid review mode.");
		if (state.mcqStreak !== undefined && (!Number.isSafeInteger(state.mcqStreak) || (state.mcqStreak as number) < 0))
			throw new ReviewError("Invalid recognition history.");
		if (state.mcqFirstDay !== undefined && state.mcqFirstDay !== null && !Number.isSafeInteger(state.mcqFirstDay))
			throw new ReviewError("Invalid recognition day.");
		ids.add(card.id);
		if (
			card.projectIds !== undefined &&
			(!Array.isArray(card.projectIds) ||
				!card.projectIds.every((id) => typeof id === "string" && token.test(id)) ||
				new Set(card.projectIds).size !== card.projectIds.length)
		)
			throw new ReviewError("The host returned invalid card projects.");
	}
	if (snapshot.projects !== undefined) {
		if (!Array.isArray(snapshot.projects)) throw new ReviewError("The host returned invalid projects.");
		const projects = new Set<string>();
		for (const value of snapshot.projects) {
			const project = objectOf(value);
			if (
				!project ||
				typeof project.id !== "string" ||
				!token.test(project.id) ||
				typeof project.name !== "string" ||
				projects.has(project.id)
			)
				throw new ReviewError("The host returned invalid projects.");
			projects.add(project.id);
		}
	}
	for (const receipt of Object.values(snapshot.receipts as Record<string, unknown>)) {
		const r = objectOf(receipt);
		if (
			!r ||
			!Number.isSafeInteger(r.through) ||
			(r.through as number) < 0 ||
			!Array.isArray(r.extra) ||
			!r.extra.every((sequence) => Number.isSafeInteger(sequence) && sequence > (r.through as number))
		)
			throw new ReviewError("The host returned invalid review receipts.");
	}
}
