import { NextResponse, type NextRequest } from "next/server";
import { remoteAccessError } from "./src/core/remote-access";
import { apiRequestRefusal, desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import { viaRemoteHost } from "./src/server/remote-api-access.ts";

/** Fork remote-host guard first (owner-pinned Tailscale host, identity,
 *  origin). API calls through that host keep its checks plus the desktop
 *  capability; Tailscale's HTTPS front end makes upstream's Host/Origin
 *  comparison misfire there. Every other API call also gets upstream's
 *  apiRequestRefusal (DNS-rebinding Host check, cross-site writes). The one
 *  route Proxy skips (the streamed plugin document endpoint) applies the same
 *  policy itself (src/server/remote-api-access.ts). */
export function proxy(request: NextRequest) {
 const error = remoteAccessError(request, { owner: process.env.LH_REMOTE_OWNER, host: process.env.LH_REMOTE_HOST, port: process.env.PORT });
 if (error) return NextResponse.json({ error }, { status: 403 });
 if (request.nextUrl.pathname === "/api" || request.nextUrl.pathname.startsWith("/api/")) {
  const refusal = viaRemoteHost(request.headers)
   ? desktopAPIAuthorized(request.headers) ? undefined : "Desktop API access requires the trusted LearnHarness window."
   : apiRequestRefusal(request);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 403, headers: { "Cache-Control": "no-store" } });
 }
 // Broken percent-encoding (/chat/%E0%A4%A) fails Next's param decode with a bare 500; show the app's 404, or a JSON 400 for the API.
 if (!decodes(request.nextUrl.pathname)) {
  if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "The request path is not valid URL encoding." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  return NextResponse.rewrite(new URL("/_lh-broken-link", request.url));
 }
 return NextResponse.next();
}

function decodes(pathname: string): boolean {
 try {
  decodeURIComponent(pathname);
  return true;
 } catch {
  return false;
 }
}

export const config = {
 // Every path (the fork's remote-host guard covers pages too), except the
 // exact streamed plugin document endpoint: Proxy's body clone would
 // truncate it. That route applies the same API policy itself. Must remain
 // static literals.
 matcher: ["/((?!api/plugins/[^/]+/documents/markdown/?$).*)"],
};
