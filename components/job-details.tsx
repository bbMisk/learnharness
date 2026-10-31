"use client";

import { useState } from "react";
import type { JobRecord } from "@/src/core";
import { VisualOutputCard } from "@/components/artifacts/visual-card";
import { DemoOutputCard } from "@/components/artifacts/demo-card";
import { PdfBriefCard, ResearchBriefCard } from "@/components/artifacts/job-card";

/** Shared inspector for the transcript and sidebar; previews never resume the teacher. */
export function JobDetails({ job, compact = false }: { job: JobRecord; compact?: boolean }) {
	const history = job.activityHistory;
	const [preview, setPreview] = useState(false);
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
			{job.result !== undefined && (
				<section data-testid="job-result-preview">
					<h4 className="mb-2 text-xs font-medium uppercase text-muted-foreground">Available result</h4>
					{compact ? (
						<details onToggle={(event) => setPreview(event.currentTarget.open)}>
							<summary className="cursor-pointer text-primary">Preview result</summary>
							{preview && <JobResult job={job} />}
						</details>
					) : (
						<JobResult job={job} />
					)}
				</section>
			)}
		</div>
	);
}

function JobResult({ job }: { job: JobRecord }) {
	return job.kind === "visual" ? (
		<VisualOutputCard output={job.result} />
	) : job.kind === "demo" ? (
		<DemoOutputCard output={job.result} />
	) : job.kind === "pdf" ? (
		<PdfBriefCard output={job.result} />
	) : (
		<ResearchBriefCard output={job.result} />
	);
}
