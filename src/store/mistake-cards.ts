import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { writeFileAtomic } from "./write-file.ts";

/** A flashcard written from a lesson mistake (server/mistake-cards.ts). It
 *  outlives the mistake's resolution; the review catalog reads it like a
 *  concept card (server/review.ts). */
export interface MistakeCard {
	/** `mistake_<chatId>_<mistakeId>`. */
	id: string;
	chatId: string;
	mistakeId: string;
	mistake: string;
	front: string;
	back: string;
	revision: string;
	createdAt: number;
}

const file = path.join(PATHS.data, "mistake-cards.json");

export function readMistakeCards(): Record<string, MistakeCard> {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const raw = JSON.parse(text);
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new Error("Saved mistake flashcards could not be read. They have not been reset.");
	return raw;
}

export function saveMistakeCard(card: MistakeCard): void {
	// Synchronous read/merge/write, like the question cache.
	const cards = readMistakeCards();
	fs.mkdirSync(PATHS.data, { recursive: true });
	writeFileAtomic(file, JSON.stringify({ ...cards, [card.id]: card }));
}
