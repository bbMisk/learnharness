// Relative Location: the browser resolves it against the host it used
// (Tailscale IP, 127.0.0.1), never the server's bind host.
export async function GET() {
	return new Response(null, { status: 307, headers: { Location: "/review/index.html" } });
}
