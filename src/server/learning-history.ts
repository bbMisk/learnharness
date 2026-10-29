import { readReviewArchive } from "../store/review.ts";
import { chatStore, captureChatLearningHistory } from "../store/chats.ts";
import { graphStore } from "../store/graph.ts";
import { getGraph } from "../core/graph.ts";
import { mergeLearningEvents } from "../core/learning-history.ts";

/** Portable raw history, separate from future scheduling policy. */
export function learningHistory(chatId?: string | null) {
	const records = chatId ? [chatStore.getChat(chatId)] : chatStore.listChats().map(chat => chatStore.getChat(chat.id));
	if (chatId && !records[0]) return null;
	let flashcards: unknown;
	try { flashcards = readReviewArchive(); }
	catch (error) { flashcards = { error: error instanceof Error ? error.message : "Flashcard archive could not be read; it has not been reset." }; }
	return {
		flashcards,
		version: 1, exportedAt: new Date().toISOString(),
		timestampSource: "Native message timestamps; not measured viewing or active study time.",
		sessions: records.flatMap(chat => chat ? [{
			id: chat.id, title: chat.title, kind: chat.kind ?? "teach", createdAt: chat.createdAt,
			events: mergeLearningEvents(chat.learningEvents, chat.messages),
		}] : []),
		concepts: getGraph(graphStore).nodes,
		// Importing notes is not evidence of a review or successful recall.
		sources: graphStore.readSources().map(({ id, filePath, displayName, importedAt }) => ({ id, filePath, displayName, importedAt })),
	};
}

/** Run inside the server's synchronous store boundary, alongside normal writes. */
export function captureLearningHistory() {
	const chats = chatStore.listChats();
	return { chats: chats.length, capturedEvents: chats.reduce((total, chat) => total + captureChatLearningHistory(chat.id), 0) };
}
