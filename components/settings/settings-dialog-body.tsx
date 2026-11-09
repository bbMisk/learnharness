"use client";
/**
 * THE SETTINGS DIALOG: a centered modal over everything, left section nav +
 * one scrolling content column.
 *
 * - Dialog, not a page: opens over whatever screen you're on, so appearance
 *   edits restyle the chat LIVE behind it. Escape, backdrop, and ✕ all
 *   close. Modal-only — /settings redirects.
 * - Left section nav in the app's mono chrome (text-only, active =
 *   bg-accent), no icons.
 * - Surface-agnostic: the sections talk to /api/settings* and localStorage
 *   only, so this shell could be re-mounted as an OS window unchanged.
 *
 * One record instance for the whole dialog behind the single `write` seam:
 * sections write through it, switching sections never refetches.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { focusComposer, useFocusReturn } from "@/components/focus-return";
import {
	CURRENT_SETTINGS_VERSION,
	type AgentSettings,
	type GeneralSettings,
	type AppearanceSettings,
	type CompactionSettings,
	type GraphSettings,
	type UserSettings,
} from "@/src/core";
import { useAppearance } from "./appearance.tsx";
import { SettingsSection } from "./controls.tsx";
import { UpdateSettings } from "./update-settings.tsx";
import { AgentSection } from "./agent-section.tsx";
import type { ModelsSettings } from "@/src/core";
import { MENU_CLOSE_EVENT, MENU_OPEN_EVENT } from "@/components/menu-shell";
import { notifySettingsSaved } from "@/components/settings-signal";
import { useOptionalServerEvent, useOptionalServerResync } from "@/components/server-events";
import { KeysSection } from "./keys-section.tsx";
import { Hint } from "@/components/ui/hint";
import { AppearanceSection, GraphSection } from "./appearance-section.tsx";
import { SettingsRow, ThinSelect, Toggle } from "./controls";
import { SessionModeChips } from "./session-mode-chips";
import { ConnectionSettings } from "./connection-settings";
import { KeyboardSection } from "./keyboard-section.tsx";

/** Hints earn their place: only the keyboard note (storage location is a
 *  real question users ask). */
const SECTIONS = [
	{ id: "keys", label: "Providers" },
	{ id: "agent", label: "Agent" },
	{ id: "appearance", label: "Appearance" },
	{ id: "graph", label: "Graph" },
	{ id: "keyboard", label: "Keyboard", hint: "Stored on this device" },
	{ id: "general", label: "General" },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];

/** The open dialog: portal + dim backdrop around the body. */
export function SettingsDialog({
	onClose,
	initialSection,
	initialRow,
}: {
	onClose: () => void;
	initialSection: SectionId;
	/** The keys-section row to unfold (see settings-dialog.tsx). */
	initialRow: string | null;
}) {
	const backdropDismiss = useBackdropDismiss(onClose);
	// Closing hands focus back to whatever held it on open (the Settings button),
	// caret included, or to the page's composer when nothing did (the /settings deep link).
	useFocusReturn(false, focusComposer);
	// Plain dim backdrop (no blur — nothing decorative); a genuine
	// backdrop click closes, the dialog body stops propagation.
	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
			data-testid="settings-backdrop"
			{...backdropDismiss}
		>
			<SettingsDialogBody onClose={onClose} initialSection={initialSection} initialRow={initialRow} />
		</div>,
		document.body,
	);
}

/** The dialog without the portal/backdrop — the SSR-testable frame
 *  (portals render nothing under renderToStaticMarkup). */
export function SettingsDialogBody({
	onClose,
	initialSection = "keys",
	initialRow = null,
}: {
	onClose: () => void;
	initialSection?: SectionId;
	/** The keys row to unfold on arrival (null = none). While-open
	 *  retargets follow it exactly like initialSection below. */
	initialRow?: string | null;
}) {
	const { onAppearanceChange } = useAppearance();
	const [record, setRecord] = useState<UserSettings | null | undefined>(
		undefined,
	);
	const [error, setError] = useState<string | null>(null);
	const [fileAccessError, setFileAccessError] = useState<string | null>(null);
	// MenuShell open-count — drives the content column's scroll lock.
	const [openMenus, setOpenMenus] = useState(0);
	const contentRef = useRef<HTMLDivElement | null>(null);
	// Scroll-lock (the scrollbar may stay, scrolling must NOT happen,
	// nothing may move): the content column keeps overflow-y-auto — the scrollbar and every width stay exactly
	// as they are — and while any MenuShell is open, non-passive wheel +
	// touchmove listeners on the column preventDefault. React attaches
	// synthetic wheel/touch passively at the root, so this needs the
	// native-listener ref seam.
	useEffect(() => {
		const el = contentRef.current;
		if (!el || openMenus === 0) return;
		const block = (e: Event) => e.preventDefault();
		el.addEventListener("wheel", block, { passive: false });
		el.addEventListener("touchmove", block, { passive: false });
		return () => {
			el.removeEventListener("wheel", block);
			el.removeEventListener("touchmove", block);
		};
	}, [openMenus]);

	useEffect(() => {
		const onOpen = () => setOpenMenus((n) => n + 1);
		const onClose = () => setOpenMenus((n) => Math.max(0, n - 1));
		window.addEventListener(MENU_OPEN_EVENT, onOpen);
		window.addEventListener(MENU_CLOSE_EVENT, onClose);
		return () => {
			window.removeEventListener(MENU_OPEN_EVENT, onOpen);
			window.removeEventListener(MENU_CLOSE_EVENT, onClose);
		};
	}, []);
	const [active, setActive] = useState<SectionId>(initialSection);
	const [savingGeneral, setSavingGeneral] = useState(false);
	// A deep-link fired while the dialog is ALREADY open changes
	// initialSection under our feet — follow it, or the link silently does
	// nothing.
	useEffect(() => {
		setActive(initialSection);
	}, [initialSection]);

	// Fetch once per dialog mount, and again after any section is saved
	// (here or in another window), so a section PUT never replaces newer
	// fields with this dialog's stale copy. 200 {settings: null} is FIRST
	// BOOT (no record = factory everything), not a failure — the error
	// state is a non-200 or a network throw only.
	const [loads, setLoads] = useState(0);
	useOptionalServerEvent("settings-changed", () => setLoads((n) => n + 1));
	// A load that failed while the server was down retries once it is back.
	useOptionalServerResync(() => { if (record === null) setLoads((n) => n + 1); });
	useEffect(() => {
		let alive = true;
		fetch("/api/settings")
			.then((r) =>
				r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)),
			)
			.then((body: { settings: UserSettings | null; fileAccessError?: string }) => {
				if (!alive) return;
				setRecord(body.settings ?? { version: CURRENT_SETTINGS_VERSION });
				setFileAccessError(body.fileAccessError ?? null);
			})
			// A failed refresh keeps the record already shown.
			.catch(() => { if (alive) setRecord((prev) => (loads === 0 ? null : prev)); });
		return () => { alive = false; };
	}, [loads]);

	// Escape closes the dialog — the outer dismiss layer. While any MenuShell
	// is open, that menu's own Esc handler (bindSettingsMenuDismiss) acts
	// instead.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && openMenus === 0) {
				// ONE Esc, one action: claim at the document level so the window
				// chain (dictation → abort) does not also act.
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose, openMenus]);

	/** ONE writer for the whole dialog: PUT the whole section, keep the
	 *  record mirror in sync, surface route errors inline (a 400 is a
	 *  schema mistake caught by the validation surface). Resolves whether it saved. */
	const write = useCallback(
		async (
			section: "general" | "agent" | "models" | "appearance" | "graph" | "compaction",
			body: object,
		): Promise<boolean> => {
			setError(null);
			const res = await fetch(`/api/settings/${section}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}).catch(() => null);
			if (!res) { setError(`${section} settings could not be saved. Try again.`); return false; }
			if (!res.ok) {
				const detail = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				setError(detail.error ?? `${section} settings could not be saved (${res.status}). Try again.`);
				return false;
			}
			// Server truth, never the request body: the server may normalize
			// on write (e.g. clamp a pinned thinking level), and the writing
			// surface must show the stored value in this same interaction.
			const reply = (await res.json().catch(() => null)) as { settings?: UserSettings; fileAccessError?: string } | null;
			const stored = reply?.settings;
			setFileAccessError(reply?.fileAccessError ?? null);
			setRecord(
				(prev) =>
					stored ?? ({ ...(prev ?? {}), [section]: body }) as UserSettings,
			);
			notifySettingsSaved(section);
			if (section === "appearance")
				onAppearanceChange(body as AppearanceSettings);
			return true;
		},
		[onAppearanceChange],
	);

	// General PUTs replace the section: retain sibling choices and serialize saves.
	const writeGeneral = async (next: GeneralSettings) => {
		if (savingGeneral) return;
		setSavingGeneral(true);
		try {
			await write("general", { ...record?.general, ...next });
		} catch {
			setError("General settings could not be saved. Try again.");
		} finally {
			setSavingGeneral(false);
		}
	};

	return (
		<div
			role="dialog"
			aria-modal="true"
			data-lh-modal
			aria-label="Settings"
			data-testid="settings-dialog"
			className="settings-dialog-pop flex h-[620px] max-h-[85vh] w-[920px] max-w-[min(90vw,calc(100vw-2*max(env(safe-area-inset-left,0px),env(safe-area-inset-right,0px))))] flex-col overflow-hidden rounded-md border border-border bg-card shadow-xl"
			onClick={(e) => e.stopPropagation()}
		>
			{/* Header — the app's quiet CMU title language. */}
			<header className="flex h-15 shrink-0 items-center gap-3 border-b border-border px-5">
				<h2 className="font-title text-2xl tracking-tight">Settings</h2>
				<Hint
						// Esc closes the dialog (its own listener) — surface it.
						label="Close"
						binding="escape"
						side="left"
					>
						<button
					type="button"
					aria-label="Close settings"
					autoFocus
					data-testid="settings-close"
					className="ml-auto size-7 rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					onClick={onClose}
				>
					<svg
						viewBox="0 0 16 16"
						className="mx-auto size-3.5"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
					>
						<path d="M4 4l8 8M12 4l-8 8" />
					</svg>
				</button>
					</Hint>
			</header>

			<div className="flex min-h-0 flex-1">
				{/* Left nav — text-only mono, active = bg-accent. */}
				<nav
					aria-label="Settings sections"
					data-testid="settings-nav"
					className="flex w-44 shrink-0 flex-col gap-1 border-r border-border p-2"
				>
					{SECTIONS.map((s) => (
						<button
							key={s.id}
							type="button"
							data-testid={`settings-nav-${s.id}`}
							aria-current={active === s.id}
							className={`rounded-sm px-3 py-1.5 text-left font-ui text-sm transition-colors ${
								active === s.id
									? "bg-accent text-foreground"
									: "text-muted-foreground hover:bg-accent hover:text-foreground"
							}`}
							onClick={() => {
								// Each section opens at its top, not the last one's scroll.
								if (contentRef.current) contentRef.current.scrollTop = 0;
								setActive(s.id);
							}}
						>
							{s.label}
						</button>
					))}
				</nav>

				{/* Content column — one section at a time, this scrolls — and
				    LOCKS while any MenuShell is open (no scrolling with a
				    dropdown down; MenuShell announces
				    open/close, the count keeps overlap honest). The lock
				    intercepts wheel/touch instead of hiding the scrollbar —
				    nothing may shift when the lock engages. */}
				<div
					ref={contentRef}
					className="min-w-0 flex-1 overflow-y-auto"
					data-testid="settings-content"
				>
					{error && (
						<p
							role="alert"
							className="m-4 rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500"
							data-testid="settings-error"
						>
							{error}
						</p>
					)}
					{record === undefined ? (
						<p className="px-6 py-5 text-xs text-muted-foreground/70">
							Loading settings…
						</p>
					) : record === null ? (
						<p className="px-6 py-5 text-xs text-muted-foreground/70">
							Settings could not be loaded — refresh to retry.
						</p>
					) : (
						<div>
							{active === "general" && (
								<SettingsSection
									title="General"
									testid="section-general"
								>
									<ConnectionSettings />
									<UpdateSettings
										autoUpdate={record.general?.autoUpdate ?? true}
										onAutoUpdateChange={(on) =>
											void write("general", { ...record.general, autoUpdate: on })
										}
									/>
									<SettingsRow
										label="Thinking while reading"
										hint="Show a notes field while reading a lesson."
										testid="row-reading-thinking"
									>
										<Toggle
											checked={record.general?.showReadingThinking ?? false}
											label="thinking while reading"
											disabled={savingGeneral}
											onChange={(on) => void writeGeneral({ showReadingThinking: on })}
										/>
									</SettingsRow>
									<SettingsRow
										label="Keep cursor in Your thinking"
										hint="During a question, typing, pasting and dictation stay in Your thinking."
										testid="row-keep-thinking-focus"
									>
										<Toggle
											checked={record.general?.keepThinkingFocus ?? true}
											label="keep cursor in your thinking"
											disabled={savingGeneral}
											onChange={(on) => void writeGeneral({ keepThinkingFocus: on })}
										/>
									</SettingsRow>
									<SettingsRow
										label="Short probe in cram mode"
										hint="Before a cram lesson, ask one quick question per big topic. Off keeps the full probe."
										testid="row-cram-short-probe"
									>
										<Toggle
											checked={record.general?.cramShortProbe ?? true}
											label="short probe in cram mode"
											disabled={savingGeneral}
											onChange={(on) => void writeGeneral({ cramShortProbe: on })}
										/>
									</SettingsRow>
									<SettingsRow
										label="Reuse the probe's cache when teaching"
										hint="Experiment: the teacher picks up the probe's cached prompt, so a lesson reads fewer new tokens. Models that can't do this are unchanged."
										testid="row-shared-handoff-prefix"
									>
										<Toggle
											checked={record.general?.sharedHandoffPrefix ?? false}
											label="reuse the probe's cache when teaching"
											disabled={savingGeneral}
											onChange={(on) => void writeGeneral({ sharedHandoffPrefix: on })}
										/>
									</SettingsRow>
									<SettingsRow
										label="Reveal questions"
										hint="A check waits behind Check your understanding until you press Enter or click."
										testid="row-reveal-questions"
									>
										<ThinSelect
											ariaLabel="Reveal questions"
											value={record.general?.revealQuestions ?? "cram"}
											disabled={savingGeneral}
											onChange={(value) => void writeGeneral({ revealQuestions: value as "cram" | "always" | "never" })}
										>
											<option value="cram">In cram mode</option>
											<option value="always">Always</option>
											<option value="never">Never</option>
										</ThinSelect>
									</SettingsRow>
									<SettingsRow
										label="Chat modes"
										hint="Hide the modes you don't use. At least one stays."
										testid="row-session-modes"
									>
										<SessionModeChips
											hidden={record.general?.hiddenModes ?? []}
											disabled={savingGeneral}
											onChange={(hiddenModes) => void writeGeneral({ hiddenModes })}
										/>
									</SettingsRow>
									<SettingsRow
										label="Show time spent on lessons"
										hint="The sidebar shows about how long you've worked on each lesson."
										testid="row-show-lesson-time"
									>
										<Toggle
											checked={record.general?.showLessonTime ?? false}
											label="show time spent on lessons"
											disabled={savingGeneral}
											onChange={(on) => void writeGeneral({ showLessonTime: on })}
										/>
									</SettingsRow>
									<SettingsRow
										label="Cards from imported knowledge"
										hint="Also make flashcards from imported material, not just chat history. Review history is kept."
										testid="row-flashcard-sources"
									>
										<Toggle
											checked={record.general?.flashcardSources === "all"}
											label="cards from imported knowledge"
											disabled={savingGeneral}
											onChange={(on) => void writeGeneral({ flashcardSources: on ? "all" : "chats" })}
										/>
									</SettingsRow>
									<SettingsRow
										label="Learning history"
										hint="Export questions, responses and timestamps for future review."
										testid="row-learning-history"
									>
										<a
											href="/api/learning-history?download=1"
											download
											className="font-ui text-xs text-foreground underline underline-offset-4"
										>
											Export JSON
										</a>
									</SettingsRow>
								</SettingsSection>
							)}
							{active === "keys" && (
								<SettingsSection title="Providers" testid="section-keys">
									<KeysSection initialRow={initialRow ?? undefined} />
								</SettingsSection>
							)}
							{active === "agent" && (
								<SettingsSection
									title="Agent"
									testid="section-agent"
								>
									<AgentSection
										agent={record.agent}
										fileAccessError={fileAccessError}
										models={record.models}
										graph={record.graph}
										compaction={record.compaction}
										onModelsChange={(next: ModelsSettings) =>
											void write("models", next)
										}
										onSectionChange={(next: AgentSettings) =>
											write("agent", next)
										}
										onCompactionChange={(next: CompactionSettings) =>
											void write("compaction", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "appearance" && (
								<SettingsSection
									title="Appearance"
									testid="section-appearance"
								>
									<AppearanceSection
										appearance={record.appearance}
										onSectionChange={(next: AppearanceSettings) =>
											void write("appearance", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "graph" && (
								<SettingsSection
									title="Graph"
									testid="section-graph"
								>
									<GraphSection
										graph={record.graph}
										onSectionChange={(next: GraphSettings) =>
											void write("graph", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "keyboard" && (
								<SettingsSection
									title="Keyboard"
									hint="Stored on this device"
									testid="section-keyboard"
								>
									<KeyboardSection />
								</SettingsSection>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
