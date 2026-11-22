import { jsonResponse, modelCatalog, prepareConnectionCatalog, refreshModelCatalog } from "@/src/server";
import type { ModelCatalogRefreshResponse } from "@/src/core";

const headers = { "Cache-Control": "no-store" };

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs. ChatGPT account discovery reuses the loaded
 * model list and refreshes it in the background (owner, 2026-10-31); a new
 * compatible model appears on the next read. Provider-key catalogs read
 * bundled and locally saved metadata.
 */
export async function GET(request: Request) {
	await prepareConnectionCatalog();
	return jsonResponse(request, modelCatalog(), { headers });
}

/** Only this explicit action may contact pi.dev. The API Proxy guards it. */
export async function POST() {
	let outcome;
	try { outcome = await refreshModelCatalog(); }
	catch { return Response.json({ error: "Model catalog refresh failed" }, { status: 502, headers }); }
	return Response.json({ outcome, catalog: modelCatalog() } satisfies ModelCatalogRefreshResponse, { headers });
}
