/**
 * GZIP JSON TRANSPORT (2026-11-02) — the one helper the large JSON reads
 * answer through: a chat open (/api/chats/[id], up to ~830 KB), the
 * learning history (~2.2 MB), the graph (~540 KB) and the review snapshot
 * (~350 KB) cross Tailscale to phones, so they go out gzip-encoded when
 * the request accepts it.
 *
 * WHY NOT next.config `compress` (Next 16.4.3, verified on the standalone
 * server): the built-in middleware (router-server.js → compiled
 * `compression`) does run for route handlers, but Next copies the Web
 * Response's headers with NodeNextResponse.appendHeader, which stores
 * EVERY header as an array — `content-type` becomes ["application/json"],
 * and compression's filter (`compressible(type)`) rejects non-strings:
 * "not compressible → filtered". Pages set a string type and do get gzip;
 * route handlers never do. The same array form makes that middleware see
 * our Content-Encoding as "already encoded", so nothing is compressed twice.
 *
 * Shape: Response.json semantics (one JSON.stringify), then a streaming
 * CompressionStream (zlib on the libuv pool, never gzipSync on the event
 * loop). Small bodies (< MIN_GZIP_BYTES) and requests that do not accept
 * gzip get the identical bytes uncompressed. Vary: Accept-Encoding on
 * both variants; no Content-Length is ever set (the encoded size is not
 * known up front — the server sends chunked). `Cache-Control: no-transform`
 * opts a response out. SSE/turn streams and file downloads never come
 * through here. Browsers' fetch decodes Content-Encoding transparently, so
 * callers' `res.json()` is unchanged.
 */

/** Below ~one TCP segment gzip saves nothing worth the header and CPU. */
export const MIN_GZIP_BYTES = 1024;

/** RFC 9110 §12.5.3: gzip is acceptable when listed with q > 0, or when
 *  unlisted and `*` is listed with q > 0. A missing header means identity. */
export function acceptsGzip(header: string | null | undefined): boolean {
	if (!header) return false;
	let gzip: number | undefined;
	let star: number | undefined;
	for (const part of header.split(",")) {
		const [rawToken = "", ...params] = part.toLowerCase().split(";");
		// Whitespace is allowed around ";" and "=" ("gzip ;q=0", "q = 0").
		const token = rawToken.trim();
		const qParam = params.map((p) => p.replace(/\s+/g, "")).find((p) => p.startsWith("q="));
		const q = qParam === undefined ? 1 : Number(qParam.slice(2));
		const weight = Number.isFinite(q) ? q : 0;
		if (token === "gzip" || token === "x-gzip") gzip = Math.max(gzip ?? 0, weight);
		else if (token === "*") star = weight;
	}
	return gzip !== undefined ? gzip > 0 : (star ?? 0) > 0;
}

/** Drop-in for `Response.json(data, init)` that gzips large bodies when
 *  `request` accepts it. */
export function jsonResponse(request: Request, data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	if (!headers.has("content-type")) headers.set("content-type", "application/json");
	headers.append("vary", "Accept-Encoding");
	headers.delete("content-length");
	const body = new TextEncoder().encode(JSON.stringify(data));
	const gzip =
		body.byteLength >= MIN_GZIP_BYTES &&
		request.method !== "HEAD" &&
		acceptsGzip(request.headers.get("accept-encoding")) &&
		!/(^|[\s,])no-transform([\s,]|$)/i.test(headers.get("cache-control") ?? "");
	if (!gzip) return new Response(body, { ...init, headers });
	headers.set("content-encoding", "gzip");
	return new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip")), { ...init, headers });
}
