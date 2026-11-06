import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReviewEngine, REVIEW_ENGINE } from "../core/review-engine.ts";
import { getGraph } from "../core/graph.ts";
import { ReviewError, type Flashcard } from "../core/review.ts";
import { readReviewArchive, syncReviewCollection } from "../store/review.ts";
import { readQuestionCache } from "../store/review-questions.ts";
import { readMistakeCards } from "../store/mistake-cards.ts";
import { readFlashcardCuration } from "../store/flashcard-curation.ts";
import { stores, effectiveSettings } from "./stores.ts";
import { projectStore } from "../store/projects.ts";

let engine: ReturnType<typeof createReviewEngine> | undefined;
function schedulingEngine() {
	return (engine ??= fs
		.readFile(path.join(process.cwd(), "public", "review", "assets", REVIEW_ENGINE.wasmFile))
		.then(createReviewEngine)
		.catch((error) => {
			engine = undefined;
			throw error;
		}));
}

export function reviewCandidates(now: number): Flashcard[] {
	const questions = readQuestionCache();
	const scope = effectiveSettings().general.flashcardSources;
	const sources = new Map(stores.graphStore.readSources().map((source) => [source.id, source]));
	const chats = new Map(stores.chatStore.listChats().map((chat) => [chat.id, chat]));
	const projects = new Set(projectStore.list().map((project) => project.id));
	// Cards written from lesson mistakes (server/mistake-cards.ts), in their chat's deck.
	const mistakes: Flashcard[] = Object.values(readMistakeCards())
		.filter((card) => chats.has(card.chatId))
		.map((card) => {
			const chat = chats.get(card.chatId)!;
			return {
				...(questions[card.revision] ? { mcq: questions[card.revision] } : {}),
				id: card.id,
				sourceNodeId: "",
				revision: card.revision,
				front: card.front,
				back: card.back,
				deckId: card.chatId,
				deckName: chat.title,
				projectIds: chat.projectId && projects.has(chat.projectId) ? [chat.projectId] : [],
				createdAt: now,
				active: true,
			};
		});
	const concepts = getGraph(stores.graphStore)
		.nodes.filter((node) => node.statement.trim() && (scope === "all" || node.provenance.some((point) => chats.has(point.chatId))))
		.map((node) => {
			const deckId =
				(scope === "chats" ? node.provenance.find((point) => chats.has(point.chatId)) : node.provenance[0])?.chatId ?? "unfiled";
			const source = sources.get(deckId);
			const front = `Explain: ${node.name}`;
			const revision = createHash("sha256")
				.update(JSON.stringify([node.id, front, node.statement]))
				.digest("hex");
			return {
				...(questions[revision] ? { mcq: questions[revision] } : {}),
				id: `card_${node.id}`,
				sourceNodeId: node.id,
				revision,
				front,
				back: node.statement,
				deckId,
				deckName: chats.get(deckId)?.title ?? source?.displayName ?? source?.filePath ?? "Unfiled",
				projectIds: [
					...new Set(
						node.provenance
							.map((point) => chats.get(point.chatId)?.projectId)
							.filter((id): id is string => !!id && projects.has(id)),
					),
				],
				createdAt: now,
				active: true,
			};
		});
	return [...concepts, ...mistakes];
}

/** Existing histories remain readable; new concepts enter the catalog after triage. */
export function reviewCatalog(now: number): Flashcard[] {
	const state = readFlashcardCuration();
	const archive = readReviewArchive();
	const existing = new Set(archive?.cards.map((card) => card.id));
	const reviewed = new Set(archive?.attempts.map((attempt) => attempt.cardId));
	const automatic = stores.settingsStore.readSettings()?.agent?.flashcards?.enabled !== false;
	return reviewCandidates(now)
		.filter((card) => {
			if (reviewed.has(card.id)) return true;
			const decision = state.decisions[card.revision];
			if (decision) return decision.keep;
			return !automatic || existing.has(card.id) || !!card.mcq;
		})
		.sort(
			(a, b) =>
				Number(!!b.mcq) - Number(!!a.mcq) ||
				(state.decisions[b.revision]?.priority ?? 0) - (state.decisions[a.revision]?.priority ?? 0),
		);
}

export async function reviewSnapshot(request?: unknown) {
	const ready = await schedulingEngine();
	const now = Date.now();
	return syncReviewCollection(
		reviewCatalog(now),
		request,
		ready,
		now,
		projectStore.list().map(({ id, name }) => ({ id, name })),
	);
}

export { ReviewError };
