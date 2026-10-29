"use client";

import { useContext, useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon, SettingsIcon, XIcon } from "lucide-react";
import { JobsContext } from "@/components/jobs-context";
import { ChatActionsContext } from "@/components/chat";
import { isModelsRefusal, isProviderKeyRefusal, type JobKind, type JobRecord } from "@/src/core";
import { BrailleSpinner } from "@/components/braille-spinner";
import { JobDetails } from "@/components/job-details";
import { jobDisplay, jobElapsedMs } from "@/src/core";

/**
 * The dispatch card (contracts.ts "THE ASYNC PROTOCOL" §4): the tool-call
 * box for a background sub-agent. The tool part's output is the FIRE-AND-
 * FORGET ACK (a string) — never the result. Live status comes from the
 * chat-view jobs feed via JobsContext, matched by toolCallId:
 *
 *   job unknown → "dispatched" pulse (the jobs feed hasn't seen it yet)
 *   running     → live activity card (activity line + elapsed)
 *   done/error  → expandable delivered / failed summary — the artifact
 *                 itself arrives in the steer message right below, so the
 *                 preview stays collapsed until explicitly opened.
 */
const KIND_LABEL: Record<JobKind, string> = {
	research: "Research agent",
	demo: "Demo agent",
	visual: "Figure agent",
	pdf: "PDF reader",
};

export function DispatchCard({ toolCallId, kind }: { toolCallId: string; kind: JobKind }) {
	const jobs = useContext(JobsContext);
	const job = jobs.find((j) => j.toolCallId === toolCallId) ?? null;
	const label = KIND_LABEL[kind];
	const [open, setOpen] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const working = job ? jobDisplay(job).working : false;
	useEffect(() => {
		if (!working) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [working]);

	if (!job) {
		return <DispatchActivityCard job={job} label={label} />;
	}
	// BYOK (owner, 2026-09-22): a job refused for missing models is INFO,
	// not scary-error — gray glyph + "needs model setup" + the deep-link
	// into the SetupDialog (the same flow the send interception uses).
	// The provider-key refusal twin (zero-keys wave): a pinned model
	// whose key is gone reads as the key being needed — the deep-link
	// lands on the SetupDialog's first-key stage on its own.
	if (isModelsRefusal(job.error)) {
		return <DispatchRefusedCard label={label} line="needs model setup" button="Set up models" />;
	}
	if (isProviderKeyRefusal(job.error)) {
		return <DispatchRefusedCard label={label} line="needs a provider key" button="Add a key" />;
	}
	const display = jobDisplay(job);
	const elapsed = jobElapsedMs(job, now);
	return <details id={`agent-${job.id}`} onToggle={(event) => setOpen(event.currentTarget.open)} className="group rounded-xl border bg-card text-card-foreground" data-testid={job.status === "running" ? "dispatch-card" : "dispatch-settled"}>
		<summary className="cursor-pointer list-none p-4 [&::-webkit-details-marker]:hidden" aria-label={`Inspect ${label}`}>
			<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{display.working ? <BrailleSpinner label={`${label} running`} /> : job.status === "error" ? <XIcon className="size-3.5 text-red-500" /> : <CheckIcon className="size-3.5" />}
				{label}{elapsed !== null && <span className="font-normal">· {Math.round(elapsed / 1000)}s</span>}
				<ChevronDownIcon className="ml-auto size-3.5 transition-transform group-open:rotate-180" />
			</div>
			<div className="mt-1 text-sm text-muted-foreground" data-testid="dispatch-activity-line">{display.working ? job.activity : display.label}</div>
		</summary>
		{open && <div className="border-t p-4"><JobDetails job={job} /></div>}
	</details>;
}

/** The refused card: quiet info tone — nothing red, nothing "failed". */
function DispatchRefusedCard({ label, line, button }: { label: string; line: string; button: string }) {
	const ctx = useContext(ChatActionsContext);
	return (
		<div
			className="flex items-center gap-2 text-xs text-muted-foreground"
			data-testid="dispatch-refused"
		>
			<SettingsIcon className="size-3.5" />
			<span className="font-medium uppercase tracking-wide">{label}</span>
			<span>{line}</span>
			{ctx && (
				<button
					type="button"
					data-testid="dispatch-setup-link"
					onClick={ctx.openSetup}
					className="ml-1 rounded-sm border border-border bg-card px-2 py-0.5 font-ui normal-case tracking-normal text-foreground transition-colors hover:border-muted-foreground/50"
				>
					{button}
				</button>
			)}
		</div>
	);
}

function DispatchActivityCard({ job, label }: { job: JobRecord | null; label: string }) {
	// Elapsed from createdAt — jobs appear here only via the jobs feed (post-mount),
	// so no SSR/hydration mismatch.
	const elapsed =
		job && job.createdAt ? Math.max(0, Math.round((Date.now() - Date.parse(job.createdAt)) / 1000)) : null;
	return (
		<div
			className="rounded-xl border bg-card p-4 text-card-foreground"
			data-testid="dispatch-card"
		>
			<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{/* The working-state grammar (owner, streaming round 2026-10-01):
				    the Braille spinner replaces the pulsing dot — one indicator
				    everywhere. This is the ONLY dispatch-card change; the card's
				    shape is untouched. */}
				<BrailleSpinner label={`${label} running`} />
				{label}
				{elapsed !== null && <span className="font-normal">· {elapsed}s</span>}
			</div>
			{job?.activity && (
				<div className="mt-1 truncate text-sm text-muted-foreground" data-testid="dispatch-activity-line">
					{job.activity}
				</div>
			)}
			{!job && (
				<div className="mt-1 text-sm text-muted-foreground" data-testid="dispatch-pending">
					Dispatched…
				</div>
			)}
		</div>
	);
}
