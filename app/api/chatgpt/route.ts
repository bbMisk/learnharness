import { chatGPTStatus, chatGPTAction, startChatGPTLogin, checkChatGPTRequest, chatGPTErrorResponse } from "@/src/server";

export const dynamic = "force-dynamic";
export async function GET() {
	try { return Response.json(chatGPTStatus(), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return chatGPTErrorResponse(error); }
}
export async function POST(request: Request) {
	try {
		checkChatGPTRequest(request);
		const body = await request.json();
		const accountId = typeof body.accountId === "string" ? body.accountId : undefined;
		if (body.action === "connect") return Response.json({ url: await startChatGPTLogin(accountId) }, { headers: { "Cache-Control": "no-store" } });
		await chatGPTAction(body.action, accountId);
		return Response.json(chatGPTStatus(), { headers: { "Cache-Control": "no-store" } });
	} catch (error) { return chatGPTErrorResponse(error); }
}
