import { modelCatalog, prepareConnectionCatalog } from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs. ChatGPT account discovery reuses the loaded
 * model list and refreshes it in the background (owner, 2026-10-31); a new
 * compatible model appears on the next read. Provider-key catalogs still
 * use Pi.
 */
export async function GET() {
	await prepareConnectionCatalog();
	return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
}
