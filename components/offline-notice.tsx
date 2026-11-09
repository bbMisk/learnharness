"use client";

import { useOffline } from "next/offline";

/** A navigation that can't reach the server waits in the app and finishes
 *  when the server is back (experimental.useOffline); this says why. */
export function OfflineNotice() {
	if (!useOffline()) return null;
	return (
		<div role="status" data-testid="offline-notice" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
			<p className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-muted-foreground shadow-lg">
				Can&apos;t reach the server. Waiting for it to come back…
			</p>
		</div>
	);
}
