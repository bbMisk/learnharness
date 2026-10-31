"use client";

import { useState } from "react";
import { useServerResync } from "@/components/server-events";

const BUILD = process.env.LH_BUILD;

/** After a deploy the events channel reconnects to a server with a new
 *  build. This window still runs the old code, so offer a reload. Never
 *  reload on its own: attachments, side-tutor conversations and edits in
 *  progress live only in this page. */
export function DeployReload({ build = BUILD, reload = () => window.location.reload() }: { build?: string; reload?: () => void }) {
	const [stale, setStale] = useState(false);
	useServerResync(() => {
		void fetch("/api/health", { cache: "no-store" })
			.then((response) => response.json() as Promise<{ build?: string }>)
			.then(({ build: served }) => {
				if (build && served && served !== build) setStale(true);
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
