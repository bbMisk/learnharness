/** Pure access policy for the optional owner-private remote host. */
export function remoteAccessError(request: Pick<Request, "headers" | "method">, config: { owner?: string; host?: string; port?: string }): string | null {
	if (!config.owner) return null;
	const host = request.headers.get("host")?.toLowerCase();
	const port = config.port || "8787";
	const local = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
	const remote = config.host?.toLowerCase();
	if (!local && host !== remote && host !== `${remote}:443`) return "Unknown LearnHarness host.";
	const identity = request.headers.get("tailscale-user-login");
	if ((!local && identity !== config.owner) || (identity && identity !== config.owner)) return "This LearnHarness belongs to a different Tailscale user.";
	const origin = request.headers.get("origin");
	if (origin) {
		try { const url = new URL(origin); if (url.host !== host || !["http:", "https:"].includes(url.protocol)) return "Cross-origin requests are not allowed."; }
		catch { return "Invalid request origin."; }
	}
	if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.get("sec-fetch-site") === "cross-site") return "Cross-site writes are not allowed.";
	return null;
}
