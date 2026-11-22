import { sideTutorSnapshot, sideTutorResponse } from "@/src/server";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return sideTutorSnapshot(request, (await params).id);
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	return sideTutorResponse(request, (await params).id);
}
