"use client";

import { useEffect } from "react";
import { useOffline } from "next/offline";
import { useServerDown } from "@/components/server-events";

/** Shown while the events channel is down, or while a navigation that
 *  couldn't reach the server waits in the app (experimental.useOffline).
 *  A strip above the app: html.lh-offline grows the top inset the whole
 *  layout already keeps clear (globals.css), so it covers nothing. In
 *  Electron it sits at the bottom, clear of the title bar. */
export function OfflineNotice() {
	const offline = useOffline();
	const down = useServerDown();
	const shown = offline || down;
	useEffect(() => {
		document.documentElement.classList.toggle("lh-offline", shown);
		return () => document.documentElement.classList.remove("lh-offline");
	}, [shown]);
	if (!shown) return null;
	return (
		<div role="status" data-testid="offline-notice" className="lh-offline-strip fixed inset-x-0 top-[env(safe-area-inset-top,0px)] z-50 flex h-7 items-center justify-center border-b border-border bg-card px-4 font-ui text-xs text-muted-foreground">
			<span className="truncate">Can&apos;t reach the server. Waiting for it to come back…</span>
		</div>
	);
}
