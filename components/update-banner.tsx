"use client";

/**
 * The auto-update banner (Wave C, owner 2026-10-10: silent download +
 * restart-banner UX). The shell pushes "lh:update-status" once a staged
 * update exists (electron/main.cjs update-downloaded). Snapshot retrieval
 * also covers a late load. The card offers Restart alongside Settings.
 * Browser builds have no window.lh and never see a push: renders null.
 *
 * macOS self-updater states (owner, 2026-11-03): when a newer version exists
 * but this copy can't replace itself, the same card asks the user to move the
 * app to Applications (translocated / disk image) or links the installer
 * (no write permission next to the app).
 *
 * Dismissing hides this version for the mounted window only; the update
 * still installs on quit (autoInstallOnAppQuit) or via Settings.
 */

import { useEffect, useState } from "react";
import { XIcon } from "lucide-react";
import { useUpdateState, MOVE_TO_APPLICATIONS, MANUAL_DOWNLOAD_URL } from "@/components/settings/update-settings.tsx";

const CARD_STATUSES = new Set(["downloaded", "move-to-applications", "manual-download"]);
const ACTION = "shrink-0 whitespace-nowrap rounded-md bg-accent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/80";

export default function UpdateBanner() {
	const { state: ready } = useUpdateState();
	const [dismissed, setDismissed] = useState<string | null>();
	const key = ready ? `${ready.status}:${ready.version}` : null;
	const shown = !!ready && CARD_STATUSES.has(ready.status) && key !== dismissed;
	// A band at the bottom: html.lh-update-band grows the bottom inset the
	// layout keeps clear (globals.css), so it covers no control.
	useEffect(() => {
		document.documentElement.classList.toggle("lh-update-band", shown);
		return () => document.documentElement.classList.remove("lh-update-band");
	}, [shown]);
	if (!shown) return null;
	return (
		<div
			data-testid="update-banner"
			data-status={ready.status}
			className="fixed inset-x-0 bottom-[calc(var(--lh-safe-bottom)-2.75rem)] z-50 flex h-11 items-center justify-center gap-3 border-t border-border bg-popover pr-[calc(1rem+env(safe-area-inset-right,0px))] pl-[calc(1rem+env(safe-area-inset-left,0px))]"
		>
			{ready.status === "downloaded" && (
				<>
					<div className="min-w-0 truncate text-sm">
						<span className="font-medium">LearnHarness {ready.version ?? "update"} is ready</span>
						<span className="text-muted-foreground"> — restart to finish installing.</span>
					</div>
					<button type="button" onClick={() => window.lh?.installUpdate?.()} className={ACTION}>
						Restart to update
					</button>
				</>
			)}
			{ready.status === "move-to-applications" && (
				<div className="min-w-0 truncate text-sm font-medium">{MOVE_TO_APPLICATIONS.replace(/\.$/, "")}</div>
			)}
			{ready.status === "manual-download" && (
				<>
					<div className="min-w-0 truncate text-sm">
						<span className="font-medium">LearnHarness {ready.version ?? "update"} is available</span>
					</div>
					<a href={MANUAL_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" className={ACTION}>
						Download update
					</a>
				</>
			)}
			<button
				type="button"
				aria-label="Dismiss update notification"
				onClick={() => setDismissed(key)}
				className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<XIcon className="size-4" aria-hidden="true" />
			</button>
		</div>
	);
}
