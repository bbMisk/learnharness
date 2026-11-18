"use client";
/**
 * THE SETTINGS DIALOG: a centered modal over everything, left section nav +
 * one scrolling content column.
 *
 * - Dialog, not a page: opens over whatever screen you're on, so appearance
 *   edits restyle the chat LIVE behind it. Escape, backdrop, and ✕ all
 *   close. Modal-only — /settings redirects.
 * - Left section nav in the app's mono chrome, with small decorative
 *   Lucide icons for the built-in sections; active = bg-accent. Icons
 *   inherit the row's color, without a separate palette.
 * - Surface-agnostic: the sections talk to /api/settings* and localStorage
 *   only, so this shell could be re-mounted as an OS window unchanged.
 *
 * One record instance for the whole dialog behind the single `write` seam:
 * sections write through it, switching sections never refetches.
 */

import { useCallback, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { BotIcon, KeyIcon, KeyboardIcon, PaletteIcon, PlugIcon, PuzzleIcon, SettingsIcon, WaypointsIcon, type LucideIcon } from "lucide-react";
import { HostDialog } from "@/components/host-dialog";
import type { CloseOutcome } from "@/components/interaction-layers";
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
import { PluginsSection } from "./plugins-section.tsx";
import { PluginSettingsPage } from "./plugin-settings-page.tsx";
import { usePlugins } from "@/components/plugins";
import { WriteOrderContext, type SettingsWriteOrder } from "./settings-dialog.tsx";

/** Hints earn their place: only the keyboard note (storage location is a
 *  real question users ask). */
const SECTIONS = [
	{ id: "keys", label: "Providers", icon: KeyIcon },
	{ id: "agent", label: "Agent", icon: BotIcon },
	{ id: "appearance", label: "Appearance", icon: PaletteIcon },
	{ id: "graph", label: "Graph", icon: WaypointsIcon },
	{ id: "keyboard", label: "Keyboard", icon: KeyboardIcon, hint: "Stored on this device" },
	{ id: "general", label: "General", icon: SettingsIcon },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"] | "plugins" | "core-plugins" | `plugin:${string}`;

/** The open dialog: the shared modal shell + plain dim backdrop around the body. */
export function SettingsDialog({
	onClose,
	initialSection,
	initialRow,
	navigationRequest,
	layerId,
}: {
	onClose: () => CloseOutcome;
	initialSection: SectionId;
	navigationRequest: number;
	layerId: string;
	/** The keys-section row to unfold (see settings-dialog.tsx). */
	initialRow: string | null;
}) {
	// Closing hands focus back to whatever held it on open (the Settings button),
	// caret included, or to the page's composer when nothing did (the /settings deep link).
	useFocusReturn(false, focusComposer);
	// Keep the original visual frame and plain dim backdrop. The shared
	// untransformed boundary also contains this modal's portaled menus.
	return <SettingsDialogBody onClose={onClose} initialSection={initialSection}
		initialRow={initialRow} navigationRequest={navigationRequest}
		renderFrame={frame => <HostDialog open layerId={layerId} ownerId={null}
			onClose={onClose} frame={frame} aria-label="Settings"
			backdropProps={{
				className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80",
				"data-testid": "settings-backdrop",
			}}>{frame.props.children}</HostDialog>} />;
}

/** The dialog without the portal/backdrop — the SSR-testable frame
 *  (portals render nothing under renderToStaticMarkup). */
export function SettingsDialogBody({
	onClose,
	initialSection = "keys",
	initialRow = null,
	navigationRequest = 0,
	renderFrame,
}: {
	onClose: () => void;
	/** The runtime supplies the shared modal shell; standalone SSR retains the frame. */
	renderFrame?: (frame: ReactElement<{ children: ReactNode }>) => ReactNode;
	initialSection?: SectionId;
	/** Repeated opens must retarget even when the requested section is unchanged. */
	navigationRequest?: number;
	/** The keys row to unfold on arrival (null = none). While-open
	 *  retargets follow it exactly like initialSection below. */
	initialRow?: string | null;
}) {
	const { onAppearanceChange } = useAppearance();
	const inheritedWriteOrder = useContext(WriteOrderContext);
	const standaloneWriteOrder = useRef<SettingsWriteOrder>({ issued: 0, acknowledged: 0, listeners: new Set() });
	const writeOrder = inheritedWriteOrder ?? standaloneWriteOrder;
	const { snapshot } = usePlugins();
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
	}, [initialSection, navigationRequest]);

	const enabledPlugins = snapshot.plugins.filter(plugin => plugin.info.enabled);
	const activePluginId = active.startsWith("plugin:") ? active.slice("plugin:".length) : null;
	const activePlugin = enabledPlugins.find(plugin => plugin.info.id === activePluginId);
	// Keep a deep link pending while discovery loads. Once discovery settles,
	// disabled/uninstalled destinations return to management, never stale DOM.
	const missingPlugin = activePluginId !== null && !activePlugin && !snapshot.loading;
	const management = snapshot.plugins.find(plugin => plugin.info.id === activePluginId)?.info.origin === "core" ? "core-plugins" : "plugins";
	useEffect(() => {
		if (missingPlugin) setActive(management);
	}, [missingPlugin, management]);
	const selected = missingPlugin ? management : active;
	const navSections: { id: SectionId; label: string; icon?: LucideIcon }[] = [
		...SECTIONS,
		{ id: "core-plugins", label: "Core plugins", icon: PlugIcon },
		{ id: "plugins", label: "Community plugins", icon: PuzzleIcon },
		...enabledPlugins.map(plugin => ({ id: `plugin:${plugin.info.id}` as const, label: plugin.info.manifest?.name ?? plugin.info.id })),
	];

	// A save may finish after its original dialog closes. Publish its
	// acknowledged snapshot to whichever Settings instance is mounted now.
	useEffect(() => {
		const authority = writeOrder.current;
		const apply = (record: UserSettings, fileAccessError: string | null) => {
			setRecord(record);
			setFileAccessError(fileAccessError);
		};
		authority.listeners.add(apply);
		return () => { authority.listeners.delete(apply); };
	}, [writeOrder]);

	// Fetch once per dialog mount, and again after any section is saved
	// (here or in another window), so a section PUT never replaces newer
	// fields with this dialog's stale copy. 200 {settings: null} is FIRST
	// BOOT (no record = factory everything), not a failure — the error
	// state is a non-200 or a network throw only.
	const [loads, setLoads] = useState(0);
	useOptionalServerEvent("settings-changed", () => setLoads((n) => n + 1));
	// A load that failed while the server was down retries once it is back.
	useOptionalServerResync(() => { if (record === null) setLoads((n) => n + 1); });
	// A GET started before a newer acknowledged save cannot roll it back.
	useEffect(() => {
		const authority = writeOrder.current;
		const acknowledgedAtRead = authority.acknowledged;
		let alive = true;
		fetch("/api/settings")
			.then((r) =>
				r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)),
			)
			.then((body: { settings: UserSettings | null; fileAccessError?: string }) => {
				if (!alive) return;
				const unchanged = authority.acknowledged === acknowledgedAtRead;
				setRecord(unchanged ? body.settings ?? { version: CURRENT_SETTINGS_VERSION } : authority.record ?? body.settings ?? { version: CURRENT_SETTINGS_VERSION });
				setFileAccessError(unchanged ? body.fileAccessError ?? null : authority.fileAccessError ?? null);
			})
			// A failed refresh keeps the record already shown.
			.catch(() => { if (alive) setRecord((prev) => (loads === 0 ? null : prev)); });
		return () => { alive = false; };
	}, [loads, writeOrder]);

	// Escape closes through the shared interaction owner (HostDialog); an
	// open MenuShell is its own, higher layer.

	/** ONE writer for the whole dialog: PUT the whole section, keep the
	 *  record mirror in sync, surface route errors inline (a 400 is a
	 *  schema mistake caught by the validation surface). Resolves whether it saved. */
	const write = useCallback(
		async (
			section: "general" | "agent" | "models" | "appearance" | "graph" | "compaction",
			body: object,
		): Promise<boolean> => {
			const ticket = ++writeOrder.current.issued;
			setError(null);
			const res = await fetch(`/api/settings/${section}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}).catch(() => null);
			if (!res) {
				if (ticket === writeOrder.current.issued) setError(`${section} settings could not be saved. Try again.`);
				return false;
			}
			if (!res.ok) {
				const detail = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				if (ticket === writeOrder.current.issued) setError(detail.error ?? `${section} settings could not be saved (${res.status}). Try again.`);
				return false;
			}
			// Server truth, never the request body: the server may normalize
			// on write (e.g. clamp a pinned thinking level), and the writing
			// surface must show the stored value in this same interaction.
			const reply = (await res.json().catch(() => null)) as { settings?: UserSettings; fileAccessError?: string } | null;
			const stored = reply?.settings;
			if (!stored || typeof stored !== "object" || Array.isArray(stored) || stored.version !== 1 ||
				!stored[section] || typeof stored[section] !== "object" || Array.isArray(stored[section])) {
				if (ticket === writeOrder.current.issued) setError(`${section}: Could not confirm saved settings. Your input has been kept.`);
				return false;
			}
			if (ticket >= writeOrder.current.acknowledged) {
				writeOrder.current.acknowledged = ticket;
				writeOrder.current.record = stored;
				writeOrder.current.fileAccessError = reply?.fileAccessError ?? null;
				for (const apply of writeOrder.current.listeners) apply(stored, writeOrder.current.fileAccessError);
				// Every accepted response is a full canonical record, including
				// appearance saved by an earlier, still-pending section request.
				onAppearanceChange(stored.appearance);
			}
			notifySettingsSaved(section);
			return true;
		},
		[onAppearanceChange, writeOrder],
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

	const frame = (
		<div
			tabIndex={-1}
			role="dialog"
			aria-modal="true"
			data-lh-modal
			aria-label="Settings"
			data-testid="settings-dialog"
			className="settings-dialog-pop outline-none flex h-[620px] max-h-[85vh] w-[920px] max-w-[min(90vw,calc(100vw-2*max(env(safe-area-inset-left,0px),env(safe-area-inset-right,0px))))] flex-col overflow-hidden rounded-md border border-border bg-card shadow-xl"
			onClick={(e) => e.stopPropagation()}
		>
			{/* Header — the app's quiet CMU title language. */}
			<header className="flex h-15 shrink-0 items-center gap-3 border-b border-border px-5">
				<h2 className="font-title text-2xl tracking-tight">Settings</h2>
				<Hint
						// Esc closes through the shared interaction owner.
						label="Close"
						binding="escape"
						side="left"
					>
						<button
					type="button"
					aria-label="Close settings"
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

			<div className="flex min-h-0 flex-1 flex-col sm:flex-row">
				{/* Left nav — mono labels and theme-inherited decorative icons,
				    active = bg-accent. Phones: a wrapping row above the content. */}
				<nav
					aria-label="Settings sections"
					data-testid="settings-nav"
					className="flex min-h-0 shrink-0 flex-wrap gap-1 overflow-y-auto border-b border-border p-2 sm:w-48 sm:flex-col sm:flex-nowrap sm:border-r sm:border-b-0"
				>
					{navSections.map((s, index) => (
						<div key={s.id} className="shrink-0">
							{index === SECTIONS.length && <hr className="my-2 border-border" />}
							<button
								type="button"
								data-testid={`settings-nav-${s.id}`}
								aria-current={selected === s.id}
								className={`flex w-full items-center gap-2 break-words rounded-sm px-3 py-1.5 text-left font-ui text-sm transition-colors ${
									selected === s.id
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:bg-accent hover:text-foreground"
								}`}
								onClick={() => {
									// Each section opens at its top, not the last one's scroll.
									if (contentRef.current) contentRef.current.scrollTop = 0;
									setActive(s.id);
								}}
							>
								{s.icon && <s.icon aria-hidden="true" focusable="false" className="size-3.5 shrink-0" />}
								<span className="min-w-0">{s.label}</span>
							</button>
							{s.id === "plugins" && <hr className="my-2 border-border" />}
						</div>
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
					{error && !activePluginId && selected !== "plugins" && selected !== "core-plugins" && (
						<p
							role="alert"
							className="m-4 rounded-sm border border-error/40 px-3 py-2 text-xs text-error"
							data-testid="settings-error"
						>
							{error}
						</p>
					)}
					{selected === "plugins" || selected === "core-plugins" ? <PluginsSection origin={selected === "core-plugins" ? "core" : "community"} onOpenSettings={pluginId => setActive(`plugin:${pluginId}`)} />
						: activePlugin ? <PluginSettingsPage key={`${activePlugin.info.id}/${activePlugin.info.revision}`} plugin={activePlugin} />
							: activePluginId !== null ? <p role="status" className="px-6 py-5 text-xs text-muted-foreground">Loading plugins…</p>
								: record === undefined ? (
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
											write("compaction", next)
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
											write("appearance", next)
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
											write("graph", next)
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
	return renderFrame ? renderFrame(frame) : frame;
}
