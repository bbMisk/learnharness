import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReviewEngine, REVIEW_ENGINE } from "../core/review-engine.ts";
import { getGraph } from "../core/graph.ts";
import { ReviewError, type Flashcard } from "../core/review.ts";
import { syncReviewCollection } from "../store/review.ts";
import { stores } from "./stores.ts";

let engine: ReturnType<typeof createReviewEngine> | undefined;
function schedulingEngine() {
	return engine ??= fs.readFile(path.join(process.cwd(), "public", "review", "assets", REVIEW_ENGINE.wasmFile)).then(createReviewEngine).catch(error => { engine = undefined; throw error; });
}

function catalog(now: number): Flashcard[] {
	const sources = new Map(stores.graphStore.readSources().map(source => [source.id, source]));
	const chats = new Map(stores.chatStore.listChats().map(chat => [chat.id, chat.title]));
	return getGraph(stores.graphStore).nodes.filter(node => node.statement.trim()).map(node => {
		const deckId = node.provenance[0]?.chatId ?? "unfiled";
		const source = sources.get(deckId);
		const front = `Explain: ${node.name}`;
		return {
			id: `card_${node.id}`, sourceNodeId: node.id, revision: createHash("sha256").update(JSON.stringify([node.id, front, node.statement])).digest("hex"),
			front, back: node.statement, deckId, deckName: chats.get(deckId) ?? source?.displayName ?? source?.filePath ?? "Unfiled",
			createdAt: now, active: true,
		};
	});
}

export async function reviewSnapshot(request?: unknown) {
	const ready = await schedulingEngine();
	const now = Date.now();
	return syncReviewCollection(catalog(now), request, ready, now);
}

export { ReviewError };
