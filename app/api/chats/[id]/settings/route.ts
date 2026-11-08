import { getChat, updateChatSettings } from "@/src/server";

/**
 * The per-chat settings control: the model pair and the lesson's question
 * type. The write's semantics (field-level merge, catalog gate,
 * clamp-on-write, the synchronous write boundary and its event) live in
 * updateChatSettings (src/server/chats.ts); this route only maps HTTP.
 */
/** Read the control's settings without transferring the lesson history. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const chat = getChat((await params).id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ settings: chat.settings }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	// Never wait on a body for a chat that is not there.
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const result = updateChatSettings(id, await req.json().catch(() => null));
	if (!result.ok) return Response.json({ error: result.error, supported: result.supported }, { status: result.status });
	return Response.json({ settings: result.settings });
}
