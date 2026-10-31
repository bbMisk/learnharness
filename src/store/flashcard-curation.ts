import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { writeFileAtomic } from "./write-file.ts";
import { cardProjectIds, UNASSIGNED_REVIEW_PROJECT, type Flashcard } from "../core/review.ts";

export interface CurationDecision { keep: boolean; priority: number; reason: string }
export interface FlashcardCuration {
    version: 1;
    decisions: Record<string, CurationDecision>;
    days: Record<string, string[]>;
    projectDays?: Record<string, Record<string, string[]>>;
    lastSignature?: string;
    lastRunAt?: number;
    lastError?: string;
}
const file = path.join(PATHS.data, "flashcard-curation.json");
export function readFlashcardCuration(): FlashcardCuration {
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {version:1, decisions:{}, days:{}}; throw error; }
    const raw = JSON.parse(text) as FlashcardCuration;
    if (raw?.version !== 1 || !raw.decisions || typeof raw.decisions !== "object" || Array.isArray(raw.decisions) || !raw.days || typeof raw.days !== "object" || Array.isArray(raw.days)) throw new Error("Saved flashcard curation could not be read. It has not been reset.");
    for (const value of Object.values(raw.decisions)) if (typeof value?.keep !== "boolean" || !Number.isInteger(value.priority) || value.priority < 0 || value.priority > 100 || typeof value.reason !== "string") throw new Error("Saved flashcard decisions are invalid. They have not been reset.");
    for (const day of Object.values(raw.days)) if (!Array.isArray(day) || !day.every(id => typeof id === "string")) throw new Error("Saved flashcard preparation budget is invalid.");
    if (raw.projectDays !== undefined) {
        if (!raw.projectDays || typeof raw.projectDays !== "object" || Array.isArray(raw.projectDays)) throw new Error("Saved project preparation budgets are invalid.");
        for (const day of Object.values(raw.projectDays)) {
            if (!day || typeof day !== "object" || Array.isArray(day) || Object.values(day).some(ids => !Array.isArray(ids) || !ids.every(id => typeof id === "string"))) throw new Error("Saved project preparation budgets are invalid.");
        }
    }
    return raw;
}

/** Attribute legacy global reservations to their source projects once, without
 * clearing a used allowance. Persisted assignments survive later chat moves. */
export function projectReservations(state: FlashcardCuration, day: string, cards: Pick<Flashcard,"revision"|"projectIds">[]): Record<string,string[]> {
    if (state.projectDays?.[day]) return state.projectDays[day];
    const byRevision = new Map(cards.map(card => [card.revision,cardProjectIds(card)]));
    const result: Record<string,string[]> = {};
    for (const revision of state.days[day] ?? []) {
        for (const group of byRevision.get(revision) ?? [UNASSIGNED_REVIEW_PROJECT]) (result[group] ??= []).push(revision);
    }
    return result;
}
/** Merge synchronously with the newest disk state; generated questions live separately. */
export function updateFlashcardCuration(update: (state: FlashcardCuration) => void): FlashcardCuration {
    const next = readFlashcardCuration(); update(next);
    fs.mkdirSync(PATHS.data,{recursive:true});
    writeFileAtomic(file, JSON.stringify(next)); return next;
}
