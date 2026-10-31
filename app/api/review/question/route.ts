import { reviewCatalog, questionFor, ReviewError } from "@/src/server";

export async function POST(request: Request) {
    const headers = {"Cache-Control":"no-store"};
    const text = await request.text();
    if (text.length > 2000) return Response.json({error:"Invalid question request."}, {status:400, headers});
    const body = await Promise.resolve().then(() => JSON.parse(text)).catch(() => null);
    if (typeof body?.cardId !== "string" || typeof body?.revision !== "string") return Response.json({error:"Choose a flashcard first."}, {status:400, headers});
    try {
        const card = reviewCatalog(Date.now()).find(card => card.id === body.cardId && card.revision === body.revision);
        if (!card) return Response.json({error:"This card changed or is outside your selected sources. Sync again."}, {status:409, headers});
        const question = await questionFor(card);
        return Response.json({cardId:card.id, revision:card.revision, question}, {headers});
    } catch (error) {
        return Response.json({error:error instanceof ReviewError ? error.message : "Could not prepare the question. Try again."}, {status:error instanceof ReviewError ? error.status : 500, headers});
    }
}
