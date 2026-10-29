import type { ReviewEngine } from "../core/review-engine.ts";
import type { Flashcard, ReviewSnapshot, StoredReview } from "../core/review.ts";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { REVIEW_ENGINE } from "../core/review-engine.ts";
import { assertReviewSnapshot, deviceReceipts, newCardSchedule, replayCard, ReviewError, validateReviewRequest } from "../core/review.ts";
export interface ReviewCollection { version: 1; id: string; revision: number; cards: Flashcard[]; versions: Record<string, Flashcard>; attempts: StoredReview[] }

const file = path.join(PATHS.data, "flashcards.json");

/** Refuse corrupt/newer data; never recover by silently creating an empty log. */
export function readReviewArchive(): ReviewCollection | null {
	let text: string;
	try { text = fs.readFileSync(file, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	let raw: ReviewCollection;
	try { raw = JSON.parse(text) as ReviewCollection; }
	catch { throw new ReviewError("Stored flashcard data could not be read. It has not been reset.", 409); }
	if (raw?.version !== 1) throw new ReviewError("Stored flashcards need a compatible app version. Reviews have not been reset.", 426);
	if (!Array.isArray(raw.cards) || !Array.isArray(raw.attempts) || !raw.versions || typeof raw.versions !== "object" || Array.isArray(raw.versions)) throw new ReviewError("Stored flashcard history is invalid. It has not been reset.", 409);
	assertReviewSnapshot({ version: 1, collectionId: raw.id, revision: raw.revision, engineId: REVIEW_ENGINE.engineId, serverAt: 0, cards: raw.cards.map(card => ({ ...card, schedule: newCardSchedule() })), receipts: {} });
	const ids = new Set<string>(), sequences = new Set<string>();
	for (const attempt of raw.attempts) {
		validateReviewRequest({ version: 1, deviceId: attempt.deviceId, attempts: [attempt] });
		const sequence = `${attempt.deviceId}:${attempt.sequence}`;
		if (ids.has(attempt.id) || sequences.has(sequence) || !Number.isSafeInteger(attempt.receivedAt) || !Number.isSafeInteger(attempt.effectiveAt) || typeof attempt.timeAdjusted !== "boolean" || !raw.versions[`${attempt.cardId}:${attempt.cardRevision}`]) throw new ReviewError("Stored review history is inconsistent. It has not been reset.", 409);
		ids.add(attempt.id); sequences.add(sequence);
	}
	return raw;
}

function persist(collection: ReviewCollection): void {
	fs.mkdirSync(PATHS.data, { recursive: true });
	const temp = `${file}.${crypto.randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(temp, "wx", 0o600);
		fs.writeFileSync(descriptor, JSON.stringify(collection), "utf8");
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor); descriptor = undefined;
		fs.renameSync(temp, file);
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		fs.rmSync(temp, { force: true });
	}
}

/** One synchronous transaction after engine initialization; no await between read/write. */
export function syncReviewCollection(catalog: Flashcard[], rawRequest: unknown, engine: ReviewEngine, now: number): ReviewSnapshot {
	const request = rawRequest === undefined ? undefined : validateReviewRequest(rawRequest);
	const existing = readReviewArchive();
	const collection: ReviewCollection = existing ?? { version: 1, id: crypto.randomUUID(), revision: 0, cards: [], versions: {}, attempts: [] };
	const oldCards = new Map(collection.cards.map(card => [card.id, card]));
	const nextCards = catalog.map(card => ({ ...card, createdAt: oldCards.get(card.id)?.createdAt ?? card.createdAt, active: true }));
	const live = new Set(nextCards.map(card => card.id));
	nextCards.push(...collection.cards.filter(card => !live.has(card.id)).map(card => ({ ...card, active: false })));
	let changed = !existing || JSON.stringify(nextCards) !== JSON.stringify(collection.cards);
	collection.cards = nextCards;
	for (const card of nextCards) {
		const key = `${card.id}:${card.revision}`, previous = collection.versions[key];
		if (previous && (previous.front !== card.front || previous.back !== card.back)) throw new ReviewError("Card revision collision. No reviews were acknowledged.", 409);
		if (!previous) { collection.versions[key] = { ...card }; changed = true; }
	}
	const byId = new Map(collection.attempts.map(attempt => [attempt.id, attempt]));
	const bySequence = new Map(collection.attempts.map(attempt => [`${attempt.deviceId}:${attempt.sequence}`, attempt.id]));
	for (const attempt of request?.attempts ?? []) {
		const previous = byId.get(attempt.id);
		if (previous) {
			const normalized = validateReviewRequest({ version: 1, deviceId: previous.deviceId, attempts: [previous] }).attempts[0];
			if (JSON.stringify(normalized) !== JSON.stringify(attempt)) throw new ReviewError("Review ID collision. Pending reviews were preserved.", 409);
			continue;
		}
		const sequence = `${attempt.deviceId}:${attempt.sequence}`;
		if (bySequence.has(sequence)) throw new ReviewError("Review sequence collision. Pending reviews were preserved.", 409);
		const card = collection.versions[`${attempt.cardId}:${attempt.cardRevision}`];
		if (!card) throw new ReviewError("This card revision is not on the host. Pending reviews were preserved; keep a backup before changing collections.", 409);
		const effectiveAt = Math.min(now, Math.max(card.createdAt, attempt.clientAt));
		const stored: StoredReview = { ...attempt, receivedAt: now, effectiveAt, timeAdjusted: effectiveAt !== attempt.clientAt };
		collection.attempts.push(stored); byId.set(stored.id, stored); bySequence.set(sequence, stored.id); changed = true;
	}
	const grouped = new Map<string, StoredReview[]>();
	for (const attempt of collection.attempts) {
		const list = grouped.get(attempt.cardId) ?? []; list.push(attempt); grouped.set(attempt.cardId, list);
	}
	const cards = collection.cards.map(card => ({ ...card, schedule: replayCard(grouped.get(card.id) ?? [], engine) }));
	const receipts = deviceReceipts(collection.attempts);
	// Compute/validate before committing, and acknowledge only after the file is flushed.
	if (changed) { collection.revision++; persist(collection); }
	return { version: 1, collectionId: collection.id, revision: collection.revision, engineId: REVIEW_ENGINE.engineId, serverAt: now, cards, receipts };
}
