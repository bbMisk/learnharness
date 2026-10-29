/** Stable, credential-free identity check for the desktop connection setting. */
export function GET() {
	return Response.json({ app: "learnharness", status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
