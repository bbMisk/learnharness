"use client";

import { MessageResponse } from "@/components/ai-elements/message";
import type { PdfResult, ResearchResult } from "@/src/core";

// The research and pdf tool-call boxes are the DispatchCard (the
// registry's dispatch renderer); their briefs ride the steer message (the
// user-role delivery injected after the wake turn) and render there.

/**
 * The PDF reading brief (sources v0) — markdown body + the consulted-pages
 * line. Exported: the steer card renders it under the PDF-complete badge,
 * the same expand-on-demand idiom as research.
 */
export function PdfBriefCard({ output }: { output: unknown }) {
	const result = output as PdfResult | undefined;
	if (!result || typeof result.brief !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				PDF reading completed, but the result could not be displayed.
			</div>
		);
	}
	const failed = result.brief.startsWith("PDF failed");
	// Read = extract/render output entered the loop; consulted = every page
	// incl. search hits (the full audit set — the brief's citations may point
	// there). The ?? fallbacks tolerate pre-split persisted records.
	const readList = result.pagesRead ?? result.pagesConsulted ?? [];
	const consultedList = result.pagesConsulted ?? [];
	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="pdf-brief-card">
			<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				PDF brief
				{failed && <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>}
			</div>
			<div className="text-sm [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
				<MessageResponse>{result.brief}</MessageResponse>
			</div>
			{!failed && readList.length > 0 && (
				<div className="mt-3 border-t pt-2 text-xs text-muted-foreground">
					Pages read: {readList.join(", ")}
				</div>
			)}
			{!failed && consultedList.length > readList.length && (
				<div className="mt-3 border-t pt-2 text-xs text-muted-foreground">
					Pages consulted: {consultedList.join(", ")}
				</div>
			)}
		</div>
	);
}

/**
 * The research brief — markdown body + a small source link list. Exported:
 * the steer card (sub-agent result delivery) renders the same artifact.
 */
export function ResearchBriefCard({ output }: { output: unknown }) {
	const result = output as ResearchResult | undefined;
	if (!result || typeof result.brief !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Research completed, but the result could not be displayed.
			</div>
		);
	}
	const failed = result.brief.startsWith("Research failed");
	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="research-brief-card">
			<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Research brief
				{failed && <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>}
			</div>
			<div className="text-sm [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
				<MessageResponse>{result.brief}</MessageResponse>
			</div>
			{result.sources.length > 0 && (
				<div className="mt-3 border-t pt-2">
					<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Sources</div>
					<ul className="flex flex-col gap-0.5 text-xs">
						{result.sources.map((s) => (
							<li key={s.url} className="truncate">
								<a
									href={s.url}
									target="_blank"
									rel="noopener noreferrer"
									className="text-primary underline-offset-2 hover:underline"
								>
									{s.title}
								</a>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
