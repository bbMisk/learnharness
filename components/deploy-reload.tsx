"use client";

import { useState } from "react";
import { useServerResync } from "@/components/server-events";

const BUILD = process.env.LH_BUILD;

/** Text a reload would throw away: any field holding unsent input. */
export function hasUnsentText(doc: Document): boolean {
	for (const el of doc.querySelectorAll<HTMLElement>('textarea, input[type="text"], [contenteditable="true"]')) {
		const text = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.textContent;
		if (text?.trim()) return true;
	}
	return false;
}

/** After a deploy the events channel reconnects to a server with a new build:
 *  reload at once when nothing unsent would be lost, otherwise offer it. */
export function DeployReload({ build = BUILD, reload = () => window.location.reload() }: { build?: string; reload?: () => void }) {
	const [stale, setStale] = useState(false);
	useServerResync(() => {
		void fetch("/api/health", { cache: "no-store" })
			.then((response) => response.json() as Promise<{ build?: string }>)
			.then(({ build: served }) => {
				if (!build || !served || served === build) return;
				if (hasUnsentText(document)) setStale(true);
				else reload();
			})
			.catch(() => {});
	});
	if (!stale) return null;
	return (
		<button
			type="button"
			onClick={reload}
			data-testid="deploy-reload"
			className="fixed bottom-4 right-4 z-50 rounded-full border bg-card px-3 py-1.5 text-xs shadow-lg hover:bg-muted"
		>
			LearnHarness was updated · Reload
		</button>
	);
}
