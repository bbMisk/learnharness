"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleHelpIcon } from "lucide-react";
import { MenuShell } from "@/components/menu-shell";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { Hint } from "@/components/ui/hint";
import { useSettingsSaved } from "@/components/settings-signal";
import { readChatSettings, readSettings } from "@/components/settings-read";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { useNewestWins, type NewestApply } from "@/components/newest-wins";
import {
	QUESTION_TYPES,
	QUESTION_TYPE_LABEL,
	effectiveQuestionType,
	sanitizeQuestionType,
	type ChatSettings,
	type EnabledTools,
	type Phase3,
	type QuestionType,
} from "@/src/core";

/** One applier per read or save of the lesson's stored question type:
 *  call it with the confirmed value. */
export type QuestionTypeApply = NewestApply<QuestionType | undefined>;

/** The lesson's stored question type as the header knows it (owner,
 *  2026-11-03), owned by the always-mounted chat view. Reads and saves race
 *  through useNewestWins (the newest confirmed value wins, so a slow save
 *  response never restores a label a newer refresh replaced). Read once on
 *  mount (a save that landed between the page render and this subscription),
 *  on the chat's chat-settings-changed event (every settings write emits it —
 *  another tab or device) and on every events reconnect (events missed
 *  while disconnected). */
export function useLessonQuestionType(chatId: string, initial: QuestionType | undefined) {
	const read = useCallback(async () => {
		return sanitizeQuestionType((await readChatSettings(chatId)).settings?.questionType);
	}, [chatId]);
	// A failed read keeps the last confirmed value; the next event or
	// reconnect retries (a save's reconcile retries on its own).
	const { value: questionType, refresh, beginSave } = useNewestWins(initial, read);
	const reread = useCallback(() => void refresh(), [refresh]);
	useEffect(reread, [reread]);
	useServerEvent("chat-settings-changed", (p) => {
		if (p.chatId === chatId) reread();
	});
	useServerResync(reread);
	return { questionType, begin: beginSave };
}

/** Whether the header shows the chip: the question type sets the TEACHER's
 *  tools, so never in a practice session and not while the prober runs. */
export function showsQuestionTypeChip(kind: "teach" | "practice", phase: Phase3): boolean {
	return kind !== "practice" && phase !== "probe";
}

/** The header's question-type chip (owner, 2026-11-03): shows the lesson's
 *  effective question type — "Qs: MCQ", "Qs: SAQ" or "Qs: Mixed" — and opens
 *  a three-option menu. A pick saves to the chat's settings
 *  (PUT /api/chats/:id/settings with only { questionType } — a field-level
 *  write, so it can never restore an older model); the tutor follows from
 *  its next request. Unset resolves like the server (core/question-type.ts):
 *  cram Mixed, else the app-wide Settings → Agent mechanic, read on mount
 *  (a change made while the chip was hidden), whenever the Agent section
 *  saves (this window's signal, or any window's settings-changed event) and
 *  on every events reconnect. */
export function QuestionTypeChip({
	chatId,
	stored,
	cram,
	initialAgentTools,
	beginSave,
}: {
	chatId: string;
	/** The chat's own stored choice (absent = unset). */
	stored: QuestionType | undefined;
	/** The lesson is in cram mode (the header's Cram chip). */
	cram: boolean;
	/** Settings → Agent's tool map as the page was served. */
	initialAgentTools?: EnabledTools;
	/** Starts a save in the lesson's ticket order (useLessonQuestionType's
	 *  begin): its applier lands the confirmed value unless a newer read won. */
	beginSave: () => QuestionTypeApply;
}) {
	const [agentTools, setAgentTools] = useState(initialAgentTools);
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const triggerRef = useRef<HTMLButtonElement>(null);
	// Esc or a pick hands focus back to the chip, once it is enabled again after a save.
	const refocus = useRef(false);
	useEffect(() => {
		if (open || saving || !refocus.current) return;
		refocus.current = false;
		const active = document.activeElement;
		if (!active || active === document.body) triggerRef.current?.focus();
	}, [open, saving]);
	const effective = effectiveQuestionType(stored, cram, agentTools);

	// The app-wide mechanic: read on mount and on every Agent save. Only the
	// latest read may land — a slower, older response never restores a
	// superseded label.
	const agentRead = useRef(0);
	const readAgentTools = useCallback(() => {
		const read = ++agentRead.current;
		readSettings()
			.then((body) => {
				if (read === agentRead.current) setAgentTools(body.settings?.agent?.tools);
			})
			.catch(() => {
				/* keep the last known mechanic */
			});
	}, []);
	useEffect(() => {
		readAgentTools();
		return () => {
			agentRead.current++;
		};
	}, [readAgentTools]);
	useSettingsSaved((section) => {
		if (section === "agent") readAgentTools();
	});
	useServerEvent("settings-changed", (p) => {
		if (p.section === "agent") readAgentTools();
	});
	useServerResync(readAgentTools);

	// The dropdown contract (model-picker's): a click outside the menu or Esc
	// closes it; the menu body lives in a portal, carved out via [data-lh-menu].
	usePopoverDismiss(triggerRef, open, useCallback(() => setOpen(false), []), {
		inside: "[data-lh-menu]",
		onEscape: useCallback(() => { refocus.current = true; setOpen(false); }, []),
	});

	const pick = async (next: QuestionType) => {
		if (saving) return;
		// Always sent, even for the type this view shows: another device may
		// have changed the stored value, and the field-level write is idempotent.
		setSaving(true);
		setError("");
		const apply = beginSave();
		try {
			const response = await fetch(`/api/chats/${chatId}/settings`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ questionType: next }),
			});
			if (!response.ok) throw new Error();
			const saved = ((await response.json().catch(() => null)) as { settings?: ChatSettings } | null)?.settings;
			apply(sanitizeQuestionType(saved?.questionType) ?? next);
			refocus.current = true;
			setOpen(false);
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
			<Hint label="Question type" side="bottom">
				<button
					ref={triggerRef}
					type="button"
					data-testid="question-type-chip"
					data-question-type={effective}
					aria-expanded={open}
					aria-haspopup="menu"
					disabled={saving}
					onClick={() => {
						setOpen((o) => !o);
						setError("");
					}}
					className="lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:cursor-default"
				>
					<CircleHelpIcon className="size-3.5 text-primary" aria-hidden />
					Qs: {QUESTION_TYPE_LABEL[effective]}
				</button>
			</Hint>
			{open && (
				<MenuShell
					anchorRef={triggerRef}
					testid="question-type-menu"
					preferredSide="down"
					menuClass="flex w-36 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					{QUESTION_TYPES.map((type) => (
						<button
							key={type}
							type="button"
							data-testid={`question-type-option-${type}`}
							aria-pressed={type === effective}
							disabled={saving}
							onClick={() => void pick(type)}
							className={`flex items-center justify-between rounded-lg px-2 py-1.5 text-left text-card-foreground transition-colors hover:bg-muted ${
								type === effective ? "bg-muted/60" : ""
							}`}
						>
							<span>{QUESTION_TYPE_LABEL[type]}</span>
							{type === effective && <span aria-hidden>✓</span>}
						</button>
					))}
				</MenuShell>
			)}
		</>
	);
}
