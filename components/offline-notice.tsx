"use client";

import { useOffline } from "next/offline";
import { useServerDown } from "@/components/server-events";

/** Shown while the events channel is down, or while a navigation that
 *  couldn't reach the server waits in the app (experimental.useOffline).
 *  Bottom-right, beside the content rather than over the transcript. */
export function OfflineNotice() {
	const offline = useOffline();
	const down = useServerDown();
	if (!offline && !down) return null;
	return (
		<div role="status" data-testid="offline-notice" className="pointer-events-none fixed right-[calc(1rem+env(safe-area-inset-right,0px))] bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] z-50 max-w-60">
			<p className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-muted-foreground shadow-lg">
				Can&apos;t reach the server. Waiting for it to come back…
			</p>
		</div>
	);
}
