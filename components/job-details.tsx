"use client";

import { Component, useEffect, useState, type ReactNode } from "react";
import type { JobRecord } from "@/src/core";
import { preloadable } from "@/components/preloadable";

/** The result renderers stay out of the text chrome's chunk; they warm when details open. */
export const JobResult = preloadable(() => import("@/components/job-result").then((m) => m.JobResult));

/** A failed renderer load stays inside the details instead of reaching the app's error screen. */
export class JobDetailsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		return this.state.failed ? <div className="text-muted-foreground">Details unavailable. Reload to retry.</div> : this.props.children;
	}
}

/** Shared inspector for the transcript and sidebar; previews never resume the teacher. */
export function JobDetails({ job, compact = false }: { job: JobRecord; compact?: boolean }) {
	const history = job.activityHistory;
	const [preview, setPreview] = useState(false);
	const hasResult = job.result !== undefined;
	useEffect(() => {
		if (hasResult) void JobResult.preload().catch(() => {});
	}, [hasResult]);
	return (
		<div
			data-testid="job-details"
			className={compact ? "min-w-0 space-y-3 text-xs text-card-foreground" : "min-w-0 space-y-4 text-sm text-card-foreground"}
		>
			<section>
				<h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Task</h4>
				<p className={compact ? "max-h-28 overflow-y-auto whitespace-pre-wrap break-words" : "whitespace-pre-wrap break-words"}>
					{job.task ?? "The task was not retained for this older job."}
				</p>
			</section>
			<section>
				<h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Activity</h4>
				{history?.length ? (
					<ol className="max-h-60 space-y-1 overflow-y-auto">
						{history.map((entry, i) => (
							<li key={i} className="flex gap-3">
								<span className="shrink-0 tabular-nums text-muted-foreground">
									{Math.max(0, Math.floor((Date.parse(entry.at) - Date.parse(job.createdAt)) / 1000))}s
								</span>
								<span className="min-w-0 break-words">{entry.text}</span>
							</li>
						))}
					</ol>
				) : (
					<p className="text-muted-foreground">
						{job.activity}
						<br />
						Earlier activity was not recorded for this job.
					</p>
				)}
			</section>
			{job.error && <p className="break-words text-red-500">{job.error}</p>}
			{hasResult && (
				<section data-testid="job-result-preview">
					<h4 className="mb-2 text-xs font-medium uppercase text-muted-foreground">Available result</h4>
					{compact ? (
						<details onToggle={(event) => setPreview(event.currentTarget.open)}>
							<summary className="cursor-pointer text-primary">Preview result</summary>
							{preview && <JobDetailsBoundary><JobResult job={job} /></JobDetailsBoundary>}
						</details>
					) : (
						<JobDetailsBoundary><JobResult job={job} /></JobDetailsBoundary>
					)}
				</section>
			)}
		</div>
	);
}
