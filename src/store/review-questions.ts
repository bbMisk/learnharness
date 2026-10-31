import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { assertReviewQuestion, type ReviewQuestion } from "../core/review.ts";
import { writeFileAtomic } from "./write-file.ts";

const file = path.join(PATHS.data, "flashcard-questions.json");
export function readQuestionCache(): Record<string, ReviewQuestion> {
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Saved flashcard questions could not be read. They have not been reset.");
    for (const value of Object.values(raw)) assertReviewQuestion(value);
    return raw;
}
export function saveReviewQuestion(revision: string, question: ReviewQuestion): void {
    assertReviewQuestion(question);
    // Synchronous read/merge/write: concurrently generated questions cannot overwrite one another.
    const cache = readQuestionCache();
    fs.mkdirSync(PATHS.data, {recursive:true});
    writeFileAtomic(file, JSON.stringify({...cache, [revision]:question}));
}
