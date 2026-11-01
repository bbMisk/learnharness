"use client";

import { useState } from "react";
import { ZapIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";

/** The header's Cram chip (owner, 2026-11-01): switches a lesson in or out of
 *  cram mode (src/core/cram.ts); the tutor follows from its next reply. */
export function CramToggle({ chatId, on, onChange }: { chatId: string; on: boolean; onChange: (on: boolean) => void }) {
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const toggle = async () => {
		setSaving(true);
		setError("");
		try {
			const response = await fetch(`/api/chats/${chatId}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ style: on ? null : "cram" }),
			});
			if (!response.ok) throw new Error();
			onChange(!on);
		} catch {
			setError("Couldn't switch. Try again.");
		} finally {
			setSaving(false);
		}
	};
	return (
		<>
			{error && (
				<span role="alert" className="shrink-0 text-xs text-destructive">
					{error}
				</span>
			)}
			<Hint label={on ? "Cram mode is on. Click for the full method." : "Cram for a test from the next reply"} side="bottom">
				<button
					type="button"
					data-testid="cram-toggle"
					aria-pressed={on}
					disabled={saving}
					onClick={() => void toggle()}
					className={
						"lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide transition-colors disabled:cursor-default " +
						(on
							? "border-border bg-accent text-foreground"
							: "border-border/80 text-muted-foreground hover:border-border hover:text-foreground")
					}
				>
					<ZapIcon className="size-3.5 text-primary" aria-hidden />
					Cram
				</button>
			</Hint>
		</>
	);
}
