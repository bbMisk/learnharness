"use client";

import { useCallback, useEffect, useState } from "react";
import { ZapIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { useNewestWins, type NewestApply } from "@/components/newest-wins";
import { useServerEvent, useServerResync } from "@/components/server-events";

/** Whether the open lesson is in cram mode, as the chat view knows it. The
 *  style is chat metadata another window can switch (setChatOrganization
 *  emits chats-changed), so it is re-read on mount, on every chats-changed
 *  and on every events reconnect; reads and the chip's own saves race
 *  through useNewestWins — the newest confirmed value wins. */
export function useLessonCram(chatId: string, initial: boolean) {
	const [cram, begin] = useNewestWins(initial);
	const refresh = useCallback(() => {
		const apply = begin();
		fetch(`/api/chats/${chatId}?only=style`, { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<{ style?: string | null }>) : Promise.reject()))
			.then((body) => apply(body.style === "cram"))
			.catch(() => {
				/* keep the last confirmed value; the next event or reconnect retries */
			});
	}, [chatId, begin]);
	useEffect(() => {
		refresh();
	}, [refresh]);
	useServerEvent("chats-changed", refresh);
	useServerResync(refresh);
	return { cram, begin };
}

/** The header's Cram chip (owner, 2026-11-01): switches a lesson in or out of
 *  cram mode (src/core/cram.ts); the tutor follows from its next reply.
 *  `beginSave` starts the save in the lesson's read order (useLessonCram's
 *  begin): its applier lands the switch unless a newer read won. */
export function CramToggle({ chatId, on, beginSave }: { chatId: string; on: boolean; beginSave: () => NewestApply<boolean> }) {
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const toggle = async () => {
		setSaving(true);
		setError("");
		const apply = beginSave();
		try {
			const response = await fetch(`/api/chats/${chatId}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ style: on ? null : "cram" }),
			});
			if (!response.ok) throw new Error();
			apply(!on);
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
