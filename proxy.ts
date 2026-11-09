import { NextResponse, type NextRequest } from "next/server";
import { remoteAccessError } from "./src/core/remote-access";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";

export function proxy(request: NextRequest) {
 const error = remoteAccessError(request, { owner: process.env.LH_REMOTE_OWNER, host: process.env.LH_REMOTE_HOST, port: process.env.PORT });
 if (error) return NextResponse.json({ error }, { status: 403 });
 if (request.nextUrl.pathname.startsWith("/api/") && !desktopAPIAuthorized(request.headers)) return NextResponse.json({ error: "Desktop API access requires the trusted LearnHarness window." }, { status: 403, headers: { "Cache-Control": "no-store" } });
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

export const config = { matcher: "/:path*" };
