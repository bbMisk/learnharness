"use client";

import { useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { useServerResync } from "@/components/server-events";

const BUILD = process.env.LH_BUILD;

/** After a deploy the events channel reconnects to a server with a new build. */
function useDeployStale(build: string | undefined): boolean {
	const [stale, setStale] = useState(false);
	useServerResync(() => {
		void fetch("/api/health", { cache: "no-store" })
			.then((response) => response.json() as Promise<{ build?: string }>)
			.then(({ build: served }) => {
				if (build && served && served !== build) setStale(true);
			})
			.catch(() => {});
	});
	return stale;
}

/** This window still runs the old code, so offer a reload. Never reload on its
 *  own: attachments, side-tutor conversations and edits in progress live only
 *  in this page. Like Codex (owner, 2026-11-01), it sits bottom-left: a row
 *  above Settings in the open sidebar, a small pill when the sidebar is closed. */
export function DeployReload({
	variant = "floating",
	hidden = false,
	build = BUILD,
	reload = () => window.location.reload(),
}: {
	variant?: "row" | "floating";
	/** Stays mounted while hidden, so it has already seen the new build when shown. */
	hidden?: boolean;
	build?: string;
	reload?: () => void;
}) {
	const stale = useDeployStale(build);
	if (!stale || hidden) return null;
	if (variant === "row")
		return (
			<div className="px-3 pt-1">
				<button
					type="button"
					onClick={reload}
					data-testid="deploy-reload"
					className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2 text-left font-ui text-xs text-foreground transition-colors hover:bg-accent"
				>
					<RefreshCwIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
					<span className="flex-1">LearnHarness updated</span>
					<span className="text-muted-foreground">Reload</span>
				</button>
			</div>
		);
	return (
		<button
			type="button"
			onClick={reload}
			data-testid="deploy-reload"
			aria-label="LearnHarness updated · Reload"
			title="LearnHarness updated · Reload"
			// Icon-only in narrow windows, where the centred composer reaches the corner.
			className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 font-ui text-xs shadow-lg hover:bg-muted max-[1100px]:px-2"
		>
			<RefreshCwIcon className="size-3.5 text-primary" aria-hidden />
			<span className="max-[1100px]:hidden">Updated · Reload</span>
		</button>
	);
}
