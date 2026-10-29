import { modelCatalog, refreshConnectionCatalog } from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs. ChatGPT account discovery refreshes on
 * access, with a one-minute server cache; new compatible model IDs do not
 * require an app or library update. Provider-key catalogs still use Pi.
 */
export async function GET() {
	await refreshConnectionCatalog();
	return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
}
