import type { ReviewEngine, ReviewMemory } from "./review-engine.ts";

export const REVIEW_PROTOCOL = 1;
export const NEW_CARDS_PER_DAY = 20;
export type ReviewRating = 1 | 2 | 3 | 4;
export interface Flashcard {
	id: string;
	sourceNodeId: string;
	revision: string;
	front: string;
	back: string;
	deckId: string;
	deckName: string;
	createdAt: number;
	active: boolean;
}
export interface CardSchedule {
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
export interface DeviceReceipt { through: number; extra: number[] }
export interface ReviewSnapshot {
	version: 1;
	collectionId: string;
	revision: number;
	engineId: string;
	serverAt: number;
	cards: Array<Flashcard & { schedule: CardSchedule }>;
	receipts: Record<string, DeviceReceipt>;
}
export interface ReviewRequest { version: 1; deviceId: string; attempts: ReviewAttempt[] }

const DAY = 86400000;
const localTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
function localParts(at: number): Record<string, number> {
	return Object.fromEntries(localTime.formatToParts(at).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
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
	if (delta) for (const [start, end, factor] of [[2.5, 7, 0.15], [7, 20, 0.1], [20, Number.MAX_VALUE, 0.05]]) {
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
			if (rating === 1) { phase = "learning"; delay = 60000; }
			if (rating === 2) { phase = "learning"; step = state.step; delay = state.step === 0 ? 330000 : 600000; }
			if (rating === 3 && state.step === 0) { phase = "learning"; step = 1; delay = 600000; }
		} else if (rating === 1 || (state.phase === "relearning" && rating === 2)) {
			phase = "relearning";
			delay = rating === 1 ? 600000 : 900000;
		}
		if (phase === "learning") intervalDays = 0;
		choices[rating] = {
			phase, step, memory: item.memory, intervalDays,
			dueAt: delay ? at + delay : dueOnStudyDay(at, intervalDays), lastReviewAt: at,
			reps: state.reps + 1, lapses: state.lapses + (state.phase === "review" && rating === 1 ? 1 : 0),
			introducedDay: state.introducedDay ?? studyDay(at),
		};
	}
	return choices;
}

export function deviceReceipts(attempts: readonly Pick<ReviewAttempt, "deviceId" | "sequence">[]): Record<string, DeviceReceipt> {
	const devices = new Map<string, Set<number>>();
	for (const attempt of attempts) {
		let sequences = devices.get(attempt.deviceId);
		if (!sequences) { sequences = new Set(); devices.set(attempt.deviceId, sequences); }
		sequences.add(attempt.sequence);
	}
	return Object.fromEntries([...devices].map(([id, sequences]) => {
		let through = 0;
		while (sequences.has(through + 1)) through++;
		return [id, { through, extra: [...sequences].filter(sequence => sequence > through).sort((a, b) => a - b) }];
	}));
}

export function isReceipted(attempt: ReviewAttempt, receipts: Record<string, DeviceReceipt>): boolean {
	const receipt = receipts[attempt.deviceId];
	return !!receipt && (attempt.sequence <= receipt.through || receipt.extra.includes(attempt.sequence));
}

export function compareReviews(a: Pick<StoredReview, "effectiveAt" | "deviceId" | "sequence" | "id">, b: Pick<StoredReview, "effectiveAt" | "deviceId" | "sequence" | "id">): number {
	return a.effectiveAt - b.effectiveAt || a.deviceId.localeCompare(b.deviceId) || a.sequence - b.sequence || a.id.localeCompare(b.id);
}

export function replayCard(attempts: readonly StoredReview[], engine: ReviewEngine): CardSchedule {
	return [...attempts].sort(compareReviews).reduce((state, review) => reviewChoices(state, review.effectiveAt, engine)[review.rating], newCardSchedule());
}

export class ReviewError extends Error {
	constructor(message: string, readonly status: 400 | 409 | 426 = 400) { super(message); this.name = "ReviewError"; }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const token = /^[A-Za-z0-9_.-]{1,128}$/;
const objectOf = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;

export function validateReviewRequest(value: unknown): ReviewRequest {
	const request = objectOf(value);
	if (request?.version !== REVIEW_PROTOCOL) throw new ReviewError("A newer flashcard app is required. Reconnect and reload; queued reviews are preserved.", 426);
	if (typeof request.deviceId !== "string" || !uuid.test(request.deviceId) || !Array.isArray(request.attempts) || request.attempts.length > 200) throw new ReviewError("Invalid device or review batch (maximum 200 attempts).");
	const deviceId = request.deviceId.toLowerCase();
	const attempts = request.attempts.map(value => {
		const a = objectOf(value);
		if (!a || typeof a.id !== "string" || !uuid.test(a.id) || typeof a.deviceId !== "string" || a.deviceId.toLowerCase() !== deviceId ||
			!Number.isSafeInteger(a.sequence) || (a.sequence as number) < 1 || (a.sequence as number) > 1_000_000_000 ||
			!([1, 2, 3, 4] as unknown[]).includes(a.rating) || typeof a.cardId !== "string" || !token.test(a.cardId) ||
			typeof a.cardRevision !== "string" || !token.test(a.cardRevision) || typeof a.engineId !== "string" || !token.test(a.engineId) ||
			!time(a.clientAt) || !time(a.shownAt) || !time(a.revealedAt) || !time(a.foregroundMs) || a.foregroundMs > 7 * DAY ||
			(a.deviceAt !== undefined && !time(a.deviceAt)) || (a.clockOffsetMs !== undefined && (typeof a.clockOffsetMs !== "number" || !Number.isFinite(a.clockOffsetMs)))) throw new ReviewError("Invalid review attempt. No reviews were acknowledged.");
		return {
			id: a.id.toLowerCase(), deviceId, sequence: a.sequence as number, cardId: a.cardId, cardRevision: a.cardRevision,
			rating: a.rating as ReviewRating, clientAt: a.clientAt, shownAt: a.shownAt, revealedAt: a.revealedAt, foregroundMs: a.foregroundMs,
			engineId: a.engineId, ...(a.deviceAt !== undefined ? { deviceAt: a.deviceAt } : {}), ...(a.clockOffsetMs !== undefined ? { clockOffsetMs: a.clockOffsetMs as number } : {}),
		};
	});
	return { version: 1, deviceId, attempts };
}

export function scheduleToken(card: Flashcard & { schedule: CardSchedule }): string {
	return JSON.stringify([card.id, card.revision, card.schedule]);
}

/** Pending ratings are provisional until the host merges all device histories. */
export function localReviewCards(snapshot: ReviewSnapshot, pending: readonly ReviewAttempt[], engine: ReviewEngine): ReviewSnapshot["cards"] {
	const cards = snapshot.cards.map(card => ({ ...card }));
	const byId = new Map(cards.map(card => [card.id, card]));
	for (const attempt of [...pending].filter(attempt => !isReceipted(attempt, snapshot.receipts)).sort((a, b) => a.clientAt - b.clientAt || a.sequence - b.sequence || a.id.localeCompare(b.id))) {
		const card = byId.get(attempt.cardId);
		if (card) card.schedule = reviewChoices(card.schedule, Math.max(card.createdAt, attempt.clientAt), engine)[attempt.rating];
	}
	return cards;
}

export function reviewQueue(cards: ReviewSnapshot["cards"], now: number, deckId = "") {
	const today = studyDay(now);
	const newRemaining = Math.max(0, NEW_CARDS_PER_DAY - cards.filter(card => card.schedule.introducedDay === today).length);
	const selected = cards.filter(card => card.active && (!deckId || card.deckId === deckId));
	const due = selected.filter(card => card.schedule.reps > 0 && card.schedule.dueAt <= now).sort((a, b) =>
		Number(b.schedule.phase !== "review") - Number(a.schedule.phase !== "review") || a.schedule.dueAt - b.schedule.dueAt || a.id.localeCompare(b.id));
	const fresh = selected.filter(card => card.schedule.reps === 0).slice(0, newRemaining);
	return { due, fresh, queue: [...due, ...fresh], newRemaining, nextDueAt: Math.min(...selected.filter(card => card.schedule.reps > 0 && card.schedule.dueAt > now).map(card => card.schedule.dueAt)) };
}

export function assertReviewSnapshot(value: unknown): asserts value is ReviewSnapshot {
	const snapshot = objectOf(value);
	if (snapshot?.version !== 1) throw new ReviewError("This flashcard data version needs an app update. Queued reviews remain saved.", 426);
	if (typeof snapshot.collectionId !== "string" || !token.test(snapshot.collectionId) || !Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 0 ||
		typeof snapshot.engineId !== "string" || !time(snapshot.serverAt) || !Array.isArray(snapshot.cards) || !objectOf(snapshot.receipts)) throw new ReviewError("The host returned invalid flashcard data.");
	const ids = new Set<string>();
	for (const value of snapshot.cards) {
		const card = objectOf(value), state = objectOf(card?.schedule), memory = objectOf(state?.memory);
		if (!card || typeof card.id !== "string" || !token.test(card.id) || ids.has(card.id) || typeof card.revision !== "string" || !token.test(card.revision) ||
			typeof card.front !== "string" || typeof card.back !== "string" || typeof card.deckId !== "string" || typeof card.deckName !== "string" || typeof card.active !== "boolean" || !time(card.createdAt) ||
			!state || !["new", "learning", "review", "relearning"].includes(state.phase as string) || !time(state.dueAt) || (state.lastReviewAt !== null && !time(state.lastReviewAt)) ||
			!Number.isSafeInteger(state.reps) || (state.reps as number) < 0 || !Number.isSafeInteger(state.lapses) || (state.lapses as number) < 0 ||
			!Number.isSafeInteger(state.step) || (state.step as number) < 0 || !Number.isSafeInteger(state.intervalDays) || (state.intervalDays as number) < 0 ||
			(state.introducedDay !== null && !Number.isSafeInteger(state.introducedDay)) ||
			(state.memory !== null && (!memory || typeof memory.stability !== "number" || !Number.isFinite(memory.stability) || memory.stability <= 0 || typeof memory.difficulty !== "number" || !Number.isFinite(memory.difficulty)))) throw new ReviewError("The host returned an invalid card. Existing local data was preserved.");
		ids.add(card.id);
	}
	for (const receipt of Object.values(snapshot.receipts as Record<string, unknown>)) {
		const r = objectOf(receipt);
		if (!r || !Number.isSafeInteger(r.through) || (r.through as number) < 0 || !Array.isArray(r.extra) || !r.extra.every(sequence => Number.isSafeInteger(sequence) && sequence > (r.through as number))) throw new ReviewError("The host returned invalid review receipts.");
	}
}
