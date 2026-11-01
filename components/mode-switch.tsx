"use client";

import { DumbbellIcon, ZapIcon } from "lucide-react";
import type { SessionMode } from "@/src/core";

const LABEL: Record<SessionMode, string> = { teach: "Teach", practice: "Practice", cram: "Cram" };

/** The new-session mode switch under the composer (home and draft views).
 *  Cram (owner, 2026-11-01) starts a lesson with a short probe and the
 *  test-focused loop (src/core/cram.ts). Shows only the modes the learner
 *  keeps (Settings → General); with one left there is nothing to switch. */
export function ModeSwitch({
	mode,
	modes,
	onChange,
	testidPrefix = "home-mode",
}: {
	mode: SessionMode;
	modes: readonly SessionMode[];
	onChange: (mode: SessionMode) => void;
	testidPrefix?: string;
}) {
	if (modes.length < 2) return null;
	return (
		<div
			className="flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5"
			data-testid={`${testidPrefix}-switch`}
		>
			{modes.map((m) => (
				<button
					key={m}
					type="button"
					data-testid={`${testidPrefix}-${m}`}
					aria-pressed={mode === m}
					onClick={() => onChange(m)}
					className={
						"flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] uppercase tracking-wider transition-colors " +
						(mode === m ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")
					}
				>
					{m === "practice" ? <DumbbellIcon aria-hidden="true" className="size-3" /> : null}
					{m === "cram" ? <ZapIcon aria-hidden="true" className="size-3" /> : null}
					{LABEL[m]}
				</button>
			))}
		</div>
	);
}
