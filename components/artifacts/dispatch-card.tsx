"use client";

import { useContext, useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon, MinusIcon, SettingsIcon, XIcon } from "lucide-react";
import { JobsContext, JobsFeedIdleContext } from "@/components/jobs-context";
import { ChatActionsContext } from "@/components/chat-actions";
import { isModelsRefusal, isProviderKeyRefusal, type ArtifactPartProps, type JobKind } from "@/src/core";
import { BrailleSpinner } from "@/components/braille-spinner";
import { JobDetails, JobResult } from "@/components/job-details";
import { jobDisplay, jobElapsedMs } from "@/src/core";

/**
 * The dispatch card (contracts.ts "THE ASYNC PROTOCOL" §4): the tool-call
 * box for a background sub-agent. The tool part's output is the FIRE-AND-
 * FORGET ACK (a string) — never the result. Live status comes from the
 * chat-view jobs feed via JobsContext, matched by toolCallId:
 *
 *   job unknown → "dispatched" pulse (the jobs feed hasn't seen it yet)
 *   running     → live activity card (activity line + elapsed)
 *   done/error  → quiet one-liner ("finished" / "failed") — the artifact
 *                 itself arrives in the steer message right below, so the
 *                 box must not duplicate it.
 */
const KIND_LABEL: Record<JobKind, string> = {
	research: "Research agent",
	demo: "Demo agent",
	visual: "Figure agent",
	pdf: "PDF reader",
	plugin: "Plugin worker",
};

export function DispatchCard(props: ArtifactPartProps | { toolCallId: string; kind: JobKind }) {
	// The registry renders it from the tool part; a plugin worker's accepted
	// call names its job directly (plugin-renderers.tsx).
	if (!("part" in props)) return <DispatchStatus toolCallId={props.toolCallId} kind={props.kind} />;
	const { part } = props;
	if (part.state !== "output-available") return null;
	return <DispatchStatus toolCallId={part.toolCallId} kind={part.type.slice("tool-".length) as JobKind} />;
}

function DispatchStatus({ toolCallId, kind }: { toolCallId: string; kind: JobKind }) {
	const jobs = useContext(JobsContext);
	const job = jobs.find((j) => j.toolCallId === toolCallId) ?? null;
	const label = kind === "plugin" ? job?.plugin?.label || job?.plugin?.toolName || KIND_LABEL.plugin : KIND_LABEL[kind];
	const [open, setOpen] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const working = job ? jobDisplay(job).working : false;
	useEffect(() => {
		if (!working) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [working]);
	// Opening the inspector shows the result at once: warm its renderers.
	const hasResult = job?.result !== undefined;
	useEffect(() => {
		if (hasResult) void JobResult.preload().catch(() => {});
	}, [hasResult]);

	if (!job) {
		return <DispatchPendingCard label={label} />;
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
				{display.working ? <BrailleSpinner label={`${label} running`} /> : job.status === "error" ? <XIcon className="size-3.5 text-error" /> : <CheckIcon className="size-3.5" />}
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

/** A live dispatch shows up in the jobs feed within moments; one that never
 *  does (an old card whose job record is gone) stops spinning after this. */
export const DISPATCH_UNKNOWN_MS = 5_000;

/** The dispatched pulse: the ack landed, the jobs feed hasn't seen the job. */
function DispatchPendingCard({ label }: { label: string }) {
	const [unknown, setUnknown] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => setUnknown(true), DISPATCH_UNKNOWN_MS);
		return () => clearTimeout(timer);
	}, []);
	// A loaded, idle jobs feed without the job settles it at once (an old
	// card on a visit), without the wait.
	const feedIdle = useContext(JobsFeedIdleContext);
	if (unknown || feedIdle) {
		return (
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="dispatch-unknown">
				<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					<MinusIcon className="size-3.5" aria-hidden />
					{label}
				</div>
				<div className="mt-1 text-sm text-muted-foreground">Status not kept for older jobs</div>
			</div>
		);
	}
	return (
		<div
			className="rounded-xl border bg-card p-4 text-card-foreground"
			data-testid="dispatch-card"
		>
			<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{/* The working-state grammar (owner, streaming round 2026-10-01):
				    the Braille spinner replaces the pulsing dot — one indicator
				    everywhere. */}
				<BrailleSpinner label={`${label} running`} />
				{label}
			</div>
			<div className="mt-1 text-sm text-muted-foreground" data-testid="dispatch-pending">
				Dispatched…
			</div>
		</div>
	);
}
