"use client";

import type { JobRecord, PluginBackgroundResult } from "@/src/core";
import { VisualOutputCard } from "@/components/artifacts/visual-card";
import { DemoOutputCard } from "@/components/artifacts/demo-card";
import { PdfBriefCard, ResearchBriefCard } from "@/components/artifacts/job-card";
import { PluginWorkerCard } from "@/components/artifacts/plugin-worker-card";

/** A job's result rendered by its artifact card (the heavy renderers job details defer). */
export function JobResult({ job }: { job: JobRecord }) {
	return job.kind === "visual" ? (
		<VisualOutputCard output={job.result} chatId={job.chatId} />
	) : job.kind === "demo" ? (
		<DemoOutputCard output={job.result} />
	) : job.kind === "pdf" ? (
		<PdfBriefCard output={job.result} />
	) : job.kind === "plugin" ? (
		<PluginWorkerCard result={job.result as PluginBackgroundResult} toolCallId={job.toolCallId} />
	) : (
		<ResearchBriefCard output={job.result} />
	);
}
