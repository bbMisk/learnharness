/**
 * POST /api/settings/file-access — check a folder before Settings lists it
 * (src/server/file-access.ts checkNewFolder). Writes nothing; the list
 * itself still saves through PUT /api/settings/agent.
 *
 *   body {folder: string, folders: string[]} → 200 {error?, warning?}
 */

import { checkNewFolder } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as { folder?: unknown; folders?: unknown } | null;
	if (typeof body?.folder !== "string") return Response.json({ error: "folder must be a string" }, { status: 400 });
	const folders = Array.isArray(body.folders) ? body.folders.filter((f): f is string => typeof f === "string") : [];
	return Response.json(checkNewFolder(body.folder, folders));
}
