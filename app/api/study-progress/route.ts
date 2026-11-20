import { studyProgress } from "@/src/server";

export function GET() {
	return Response.json(studyProgress(), { headers: { "Cache-Control": "no-store" } });
}
