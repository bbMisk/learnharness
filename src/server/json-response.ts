/**
 * JSON for the large reads (a chat open, the learning history, the graph).
 *
 * This helper must NOT encode the body. Next's built-in compression
 * (next.config `compress`, on by default) gzips route-handler responses from
 * Next 16.4.6 on. Up to 16.4.3 it skipped them, so this helper used to gzip
 * the body itself; after the upgrade every body over 1 KB went out
 * gzip-encoded twice and the app could not read the chat list, the graph or
 * the model list (2026-11-22). scripts/smoke-server.mjs now parses the API
 * probes as JSON, which fails on a twice-encoded body.
 *
 * Kept as the one place those reads answer through; `request` stays in the
 * signature so the call sites did not have to change.
 */
export function jsonResponse(_request: Request, data: unknown, init: ResponseInit = {}): Response {
	return Response.json(data, init);
}
