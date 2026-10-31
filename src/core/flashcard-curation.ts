import { ReviewError } from "./review.ts";

export interface FlashcardTriage { revision: string; keep: boolean; priority: number; reason: string }
/** A model can decide only among the supplied candidates, once each. */
export function parseFlashcardTriage(raw: unknown, revisions: readonly string[]): FlashcardTriage[] {
    const items = (raw as {decisions?:unknown} | null)?.decisions;
    if (!Array.isArray(items) || items.length !== revisions.length) throw new ReviewError("The curator did not classify every candidate. No decisions were saved.",409);
    const allowed = new Set(revisions), seen = new Set<string>();
    return items.map(item => {
        if (!item || typeof item !== "object" || typeof item.revision !== "string" || !allowed.has(item.revision) || seen.has(item.revision) || typeof item.keep !== "boolean" || !Number.isInteger(item.priority) || item.priority < 0 || item.priority > 100 || typeof item.reason !== "string" || item.reason.length > 1000) throw new ReviewError("The curator returned an invalid decision. No decisions were saved.",409);
        seen.add(item.revision);
        return {revision:item.revision,keep:item.keep,priority:item.priority,reason:item.reason};
    });
}

/** Short request-local labels avoid asking a model to reproduce 64-character
 * content hashes. Identity is restored on the host, never guessed or repaired. */
export function parseLabeledFlashcardTriage(raw: unknown, revisions: readonly string[]): FlashcardTriage[] {
    const items=(raw as {decisions?:unknown}|null)?.decisions;
    if(!Array.isArray(items))throw new ReviewError("The curator returned no decisions. No decisions were saved.",409);
    const labels=new Map(revisions.map((revision,index)=>[`c${index+1}`,revision]));
    const mapped=items.map(item=>{
        if(!item||typeof item!=="object"||typeof item.id!=="string"||!labels.has(item.id))throw new ReviewError("The curator returned an unknown candidate label. No decisions were saved.",409);
        return {revision:labels.get(item.id)!,keep:item.keep,priority:item.priority,reason:item.reason};
    });
    return parseFlashcardTriage({decisions:mapped},revisions);
}
