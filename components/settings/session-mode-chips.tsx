"use client";

import { SESSION_MODES, visibleModes, type SessionMode } from "@/src/core";

const LABEL: Record<SessionMode, string> = { teach: "Teach", practice: "Practice", cram: "Cram" };

/** Settings → General → Session modes (owner, 2026-11-01): a pressed chip is
 *  offered in the mode switch and sidebar; the last one shown cannot be hidden. */
export function SessionModeChips({
	hidden,
	disabled,
	onChange,
}: {
	hidden: readonly SessionMode[];
	disabled?: boolean;
	onChange: (hidden: SessionMode[]) => void;
}) {
	const shownCount = visibleModes(hidden).length;
	return (
		<div className="flex gap-1" role="group" aria-label="Session modes">
			{SESSION_MODES.map((mode) => {
				const shown = !hidden.includes(mode);
				const last = shown && shownCount === 1;
				return (
					<button
						key={mode}
						type="button"
						aria-pressed={shown}
						data-testid={`session-mode-${mode}`}
						disabled={disabled || last}
						title={last ? "At least one mode stays." : undefined}
						onClick={() => onChange(shown ? [...hidden, mode] : hidden.filter((m) => m !== mode))}
						className={
							"h-7 rounded-sm border px-2 font-ui text-xs transition-colors disabled:cursor-default " +
							(shown
								? "border-border bg-accent text-foreground"
								: "border-border/60 text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground")
						}
					>
						{LABEL[mode]}
					</button>
				);
			})}
		</div>
	);
}
