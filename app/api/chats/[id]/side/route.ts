import { sideChatSnapshot, sideChatResponse } from "@/src/server";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return sideChatSnapshot(request, (await params).id);
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return sideChatResponse(request, (await params).id);
}
