import { NextResponse, type NextRequest } from "next/server";
import { remoteAccessError } from "./src/core/remote-access";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";

export function proxy(request: NextRequest) {
 const error = remoteAccessError(request, { owner: process.env.LH_REMOTE_OWNER, host: process.env.LH_REMOTE_HOST, port: process.env.PORT });
 if (error) return NextResponse.json({ error }, { status: 403 });
 if (request.nextUrl.pathname.startsWith("/api/") && !desktopAPIAuthorized(request.headers)) return NextResponse.json({ error: "Desktop API access requires the trusted LearnHarness window." }, { status: 403, headers: { "Cache-Control": "no-store" } });
 return NextResponse.next();
}

export const config = { matcher: "/:path*" };
