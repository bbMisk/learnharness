"use client";

import { useState } from "react";
import { STYLE_GO_AHEAD, type TeachingStyle } from "@/src/core";

const BUTTON =
	"cursor-pointer rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent disabled:cursor-default disabled:opacity-50";

/** The plan-phase choice (owner, 2026-11-01): once the probe has produced a
 *  plan, the learner picks the full method or the test-focused cram loop.
 *  The choice is saved on the chat, then sent as the go-ahead reply. */
export function CramChoice({ chatId, onChosen }: { chatId: string; onChosen: (style: TeachingStyle, goAhead: string) => void }) {
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const choose = async (style: TeachingStyle) => {
		setSaving(true);
		setError("");
		try {
			const response = await fetch(`/api/chats/${chatId}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ style: style === "cram" ? "cram" : null }),
			});
			if (!response.ok) throw new Error();
			onChosen(style, STYLE_GO_AHEAD[style]);
		} catch {
			setError("The choice could not be saved. Try again.");
		} finally {
			setSaving(false);
		}
	};
	return (
		<div className="pointer-events-auto mb-2 flex flex-col items-center gap-1.5" data-testid="cram-choice">
			<div className="flex items-center gap-2">
				<button
					type="button"
					className={BUTTON}
					disabled={saving}
					onClick={() => void choose("teach")}
					title="The full method: build understanding node by node."
				>
					Teach it
				</button>
				<button
					type="button"
					className={BUTTON}
					disabled={saving}
					onClick={() => void choose("cram")}
					title="Test-focused: each problem class, a worked example, then you solve one yourself."
				>
					Cram for a test
				</button>
			</div>
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
