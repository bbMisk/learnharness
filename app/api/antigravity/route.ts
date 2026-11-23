import { antigravityResponse } from "@/src/server";

/** Hanson's fork (docs/antigravity.md): status, opt-in and "check connection".
 *  Every method answers 404 while the server switch is off. */
export async function GET(request: Request) {
	return antigravityResponse(request);
}

export async function PUT(request: Request) {
	return antigravityResponse(request);
}

export async function POST(request: Request) {
	return antigravityResponse(request);
}
