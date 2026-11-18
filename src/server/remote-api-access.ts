import { remoteAccessError } from "../core/remote-access.ts";
import { apiRequestRefusal, desktopAPIAuthorized } from "./desktop-access.ts";

/** Fork: the request addressed the configured owner-private remote host
 *  (Tailscale), which remoteAccessError has already pinned (host, identity,
 *  origin). */
export function viaRemoteHost(headers: Pick<Headers, "get">, env: Record<string, string | undefined> = process.env): boolean {
	const remote = env.LH_REMOTE_OWNER ? env.LH_REMOTE_HOST?.toLowerCase() : undefined;
	const host = headers.get("host")?.toLowerCase();
	return !!remote && (host === remote || host === `${remote}:443`);
}

/** Fork API policy, shared by proxy.ts and the routes Proxy skips (the
 *  streamed plugin document endpoint): the remote-host guard first; API calls
 *  through that host keep the desktop capability check (Tailscale's HTTPS
 *  front end makes upstream's Host/Origin comparison misfire there); every
 *  other API call gets upstream's apiRequestRefusal. */
export function forkAPIRequestRefusal(request: Request, env: Record<string, string | undefined> = process.env): string | undefined {
	const error = remoteAccessError(request, { owner: env.LH_REMOTE_OWNER, host: env.LH_REMOTE_HOST, port: env.PORT });
	if (error) return error;
	if (viaRemoteHost(request.headers, env)) {
		return desktopAPIAuthorized(request.headers, env) ? undefined : "Desktop API access requires the trusted LearnHarness window.";
	}
	return apiRequestRefusal(request, env);
}
