import { abortFlashcardAgent, flashcardAgentStatus, scheduleFlashcardCuration } from "@/src/server";
export const dynamic = "force-dynamic";
export async function GET() { return Response.json(flashcardAgentStatus(),{headers:{"Cache-Control":"no-store"}}); }
export async function POST() { scheduleFlashcardCuration(true); return Response.json({ok:true},{status:202}); }
export async function DELETE() { abortFlashcardAgent(); return Response.json({ok:true}); }
