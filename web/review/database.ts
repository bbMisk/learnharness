import type { ReviewEngine } from "../../src/core/review-engine.ts";
import type { ReviewAttempt, ReviewSnapshot } from "../../src/core/review.ts";
import { assertReviewSnapshot, isReceipted, localReviewCards, ReviewError, scheduleToken, validateReviewRequest } from "../../src/core/review.ts";

export interface LocalReviewState { version: 1; deviceId: string; sequence: number; snapshot: ReviewSnapshot | null; pending: ReviewAttempt[]; clockOffsetMs: number; lastSyncedAt: number | null }
export interface ReviewDatabase { read(): Promise<LocalReviewState>; change(update: (state: LocalReviewState) => LocalReviewState): Promise<LocalReviewState>; close(): void }

function initialState(): LocalReviewState {
	return { version: 1, deviceId: crypto.randomUUID(), sequence: 0, snapshot: null, pending: [], clockOffsetMs: 0, lastSyncedAt: null };
}

function checkState(state: LocalReviewState): void {
	if (state.version !== 1) throw new ReviewError("Local data needs a newer app version. It has not been reset.", 426);
	if (!Array.isArray(state.pending) || !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !Number.isFinite(state.clockOffsetMs)) throw new Error("Local review storage is invalid. It has not been reset.");
	for (let i = 0; i < Math.max(1, state.pending.length); i += 200) validateReviewRequest({ version: 1, deviceId: state.deviceId, attempts: state.pending.slice(i, i + 200) });
	if (state.pending.some(attempt => attempt.sequence > state.sequence)) throw new Error("Local review sequence is invalid. It has not been reset.");
	if (state.snapshot) assertReviewSnapshot(state.snapshot);
}

export async function openReviewDatabase(factory: IDBFactory = indexedDB): Promise<ReviewDatabase> {
	const connection = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = factory.open("learnharness-review", 1);
		let blocked = false;
		request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("state")) request.result.createObjectStore("state"); };
		request.onblocked = () => { blocked = true; reject(new Error("Close other flashcard tabs, then reopen this app. Reviews have not been reset.")); };
		request.onerror = () => reject(request.error ?? new Error("Could not open local review storage."));
		request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
	});
	connection.onversionchange = () => connection.close();
	const database: ReviewDatabase = {
		read() {
			return new Promise((resolve, reject) => {
				const tx = connection.transaction("state", "readonly"), request = tx.objectStore("state").get("current");
				request.onsuccess = () => {
					try { const state = request.result as LocalReviewState; checkState(state); resolve(state); }
					catch (error) { reject(error); }
				};
				request.onerror = () => reject(request.error);
			});
		},
		change(update) {
			return new Promise((resolve, reject) => {
				const tx = connection.transaction("state", "readwrite", { durability: "strict" });
				const store = tx.objectStore("state"), request = store.get("current");
				let result: LocalReviewState, failure: unknown;
				request.onsuccess = () => {
					try {
						const previous = (request.result as LocalReviewState | undefined) ?? initialState();
						checkState(previous);
						result = update(previous);
						checkState(result);
						store.put(result, "current");
					} catch (error) { failure = error; tx.abort(); }
				};
				tx.oncomplete = () => resolve(result);
				tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error("This device could not save the review. The card has not advanced."));
			});
		},
		close: () => connection.close(),
	};
	try { await database.change(state => state); }
	catch (error) { connection.close(); throw error; }
	return database;
}

/** No async work inside the IDB transaction: a tab sees and updates one state. */
export async function enqueueReview(db: ReviewDatabase, draft: Omit<ReviewAttempt, "id" | "deviceId" | "sequence">, token: string, engine: ReviewEngine): Promise<LocalReviewState> {
	return db.change(state => {
		if (!state.snapshot) throw new Error("Connect once to download flashcards.");
		const card = localReviewCards(state.snapshot, state.pending, engine).find(card => card.id === draft.cardId);
		if (!card || scheduleToken(card) !== token) throw new ReviewError("This card changed in another tab or during sync. Please review the updated card.", 409);
		const attempt = { ...draft, id: crypto.randomUUID(), deviceId: state.deviceId, sequence: state.sequence + 1 };
		validateReviewRequest({ version: 1, deviceId: state.deviceId, attempts: [attempt] });
		return { ...state, sequence: attempt.sequence, pending: [...state.pending, attempt] };
	});
}

export async function reconcileReviewSnapshot(db: ReviewDatabase, incoming: ReviewSnapshot, offset: number): Promise<LocalReviewState> {
	assertReviewSnapshot(incoming);
	return db.change(state => {
		if (state.snapshot && state.snapshot.collectionId !== incoming.collectionId && state.pending.length) throw new ReviewError("The host collection changed. Your pending reviews are preserved; back them up before reconnecting to a different collection.", 409);
		const current = state.snapshot;
		const newer = !current || current.collectionId !== incoming.collectionId || incoming.revision > current.revision || (incoming.revision === current.revision && incoming.serverAt >= current.serverAt);
		const snapshot = newer ? incoming : current;
		return { ...state, snapshot, pending: state.pending.filter(attempt => !isReceipted(attempt, snapshot.receipts)), clockOffsetMs: newer ? Math.round(offset) : state.clockOffsetMs, lastSyncedAt: Date.now() };
	});
}
