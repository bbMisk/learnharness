"use client";
/**
 * The Agent section: the THREE MODEL SLOTS, the tool toggles + the
 * search-engine preference, and the prompt override switches — three
 * GROUPS (Models / Tools / System prompts).
 *
 * Model slots (per-role overrides exist in the schema but have no UI):
 * Strong = Prober + Teacher, Cheap = the five workhorse roles, Vision =
 * Visual maker + PDF reader. Each slot row carries the shared dropdown
 * (fuzzy search, arrow-walk, Enter pick — ModelMenuList/ThinkingMenuList
 * from ./model-menu.tsx) over the FEDERATED catalog (/api/models serves
 * only keyed providers, fresh per call — saving a key in Keys immediately
 * widens this picker). The vision slot filters to image-capable models
 * (Model.input). The slots live in the `models` settings section
 * (PUT /api/settings/models — slot pins are engine-level, not per-chat);
 * the rest of the section writes the `agent` section. There is no factory
 * fallback: an unpicked slot's trigger reads "—". A stored id stays
 * VISIBLE even when its provider's key lapsed out of the catalog — the
 * trigger must never lie about the record.
 *
 * Search engine (no default — an engine is live iff its key is present;
 * with a key the engine AUTO-activates, the explicit choice is only a
 * preference between live engines): a row in the Tools group, with the
 * same shared-menu look and the live reason line from /api/search. No
 * engine key at all → the row grays whole-row (a choice without a key
 * would only BLOCK another engine's auto-activation).
 *
 * Tools: research, demo, visual, pdf. Absent key = enabled in the schema;
 * the UI writes explicit booleans (sanitize-equivalent).
 *
 * Prompts: GET /api/settings/prompts segments — Teacher, Prober, Practice,
 * then Shared LAST. The server returns each agent's actual segments,
 * including its shared subset; sectionedSegments deduplicates shared
 * chunks and derives per-fragment usage from membership in those lists.
 * Only the TOGGLE grays when there's no override file (the file name is
 * always full-contrast); the indicator ("Your version is in use") appears
 * ONLY when the switch is on. The switch requires an override FILE
 * (route-enforced), so a file-less toggle is disabled. The segments view
 * re-reads on the 'lh:settings-saved' signal for the agent section — its
 * enabled flags derive from the record's switches, so without the re-read
 * the toggle would paint its old state until a remount.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CacheRetention } from "@earendil-works/pi-ai";
import { CacheRetentionMenu, cacheRetentionLabel } from "./cache-retention-menu.tsx";
import { MenuShell } from "@/components/menu-shell";
import { useSettingsSaved } from "@/components/settings-signal";
import { defaultOrderLevel, populateLevel } from "@/components/thinking-default";
import { useModelCatalog } from "@/components/model-catalog";
import { Hint } from "@/components/ui/hint";
import {
	COMPACTION_THRESHOLD_FLOOR,
	COMPACTION_THRESHOLD_MAX,
	MODEL_SLOTS,
	SEARCH_ENGINES,
	resolveSettings,
	isFileAccessFolder,
	type AgentSettings,
	type CompactionSettings,
	type GraphSettings,
	type ModelSlotName,
	type ModelsSettings,
	type SearchEngineId,
} from "@/src/core";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { prettyModel } from "@/components/usage-format";
import { cn } from "@/lib/utils";
import { bindSettingsMenuDismiss, SettingsGroup, SettingsRow, SettingsMenuTrigger, Toggle, CommitInput } from "./controls.tsx";
import { FlashcardAgentSection } from "./flashcard-agent-section";
import { ModelInstructionsSection } from "./model-instructions-section";
import { ModelMenuList, ThinkingMenuList } from "./model-menu";
import { ChatGPTBackgroundAccess } from "./chatgpt-connection";
import { NativeSubscriptionBackgroundAccess } from "./subscription-connections";

/** One slot's display identity — the label and the tier's roster (the
 *  row hint). */
const SLOT_META: Record<ModelSlotName, { label: string; roster: string }> = {
	strong: { label: "Strong", roster: "The main model for your sessions" },
	cheap: { label: "Cheap", roster: "The assistants that research, build demos, and grade your work" },
	vision: { label: "Vision", roster: "The assistants that draw and read PDFs" },
};

/** The toggleable-tool list (a product decision — confirm before
 *  changing). */
export const TOGGLE_TOOLS = ["research", "demo", "visual", "pdf"] as const;

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** SegmentInfo as GET /api/settings/prompts returns it. */
interface SegmentInfo {
	path: string;
	sourceText: string;
	overrideText: string | null;
	enabled: boolean;
	shared: boolean;
}

type PromptView = Record<"teacher" | "prober" | "practice", SegmentInfo[]>;
type PromptRow = SegmentInfo & { usageHint?: string };

/** Unsaved prompt-override drafts per path, kept for the app session:
 *  Esc or closing Settings never throws typed text away. */
const segmentDrafts: Record<string, string> = {};

/** Compose: one tool toggled, the rest of the section carried verbatim.
 *  Pure — exported for tests. */
export function composeTool(agent: AgentSettings | undefined, id: string, on: boolean): AgentSettings {
	return { ...agent, tools: { ...agent?.tools, [id]: on } };
}

/** A file-access folder entry the server will accept: absolute (POSIX or
 *  Windows drive/UNC) or "~"-anchored. Pure — exported for tests. */
export function isFolderEntry(folder: string): boolean { return isFileAccessFolder(folder); }

/** The switch changes ONLY restriction, never discards saved folders. */
export function composeFileRestriction(agent: AgentSettings | undefined, restricted: boolean): AgentSettings {
	return { ...agent, fileAccess: { restricted, folders: agent?.fileAccess?.folders ?? [] } };
}

/** The folder as typed, trimmed and without trailing separators, so
 *  "/tmp/" and "/tmp" are one entry. A root stays as it is. */
export function normalizeFolder(folder: string): string {
	const trimmed = folder.trim();
	const stripped = trimmed.replace(/[\\/]+$/, "");
	return stripped && !/^[A-Za-z]:$/.test(stripped) ? stripped : trimmed;
}

/** A whole-disk root: listing it would allow everything. */
export function isRootFolder(folder: string): boolean {
	return /^([\\/]+|[A-Za-z]:[\\/]+)$/.test(folder.trim());
}

/** Compose: add one allowed folder (normalized; duplicates, roots and
 *  invalid entries are no-ops). Pure — exported for tests. */
export function composeAddFolder(agent: AgentSettings | undefined, folder: string): AgentSettings {
	const next = normalizeFolder(folder);
	const folders = agent?.fileAccess?.folders ?? [];
	const restricted = agent?.fileAccess?.restricted ?? false;
	if (!isFolderEntry(next) || isRootFolder(next) || folders.map(normalizeFolder).includes(next)) return { ...agent, fileAccess: { restricted, folders } };
	return { ...agent, fileAccess: { restricted, folders: [...folders, next] } };
}

/** Removing the last folder NEVER changes the restriction switch. */
export function composeRemoveFolder(agent: AgentSettings | undefined, folder: string): AgentSettings {
	return { ...agent, fileAccess: { restricted: agent?.fileAccess?.restricted ?? false, folders: (agent?.fileAccess?.folders ?? []).filter((f) => f !== folder) } };
}

/** The quizzing mechanics: a segmented control, not a
 *  toggle — exactly one mechanic is ever active. `explain: true` arms
 *  free-recall (explain in, quiz out); anything else is multiple choice.
 *  `quiz` itself is never written (mechanics-managed — see quizMechanics
 *  in agent/tools.ts). Pure — exported for tests. */
export function composeQuizMechanics(agent: AgentSettings | undefined, mechanics: "choice" | "free"): AgentSettings {
	return { ...agent, tools: { ...agent?.tools, explain: mechanics === "free" } };
}

/** Compose the prober graph-tools toggle: its own key in the agent
 *  section — never in the tool-toggles map. Absent = ON; the write is
 *  explicit either way, so an
 *  explicit-off record stays visible as stored. Pure — exported for tests. */
export function composeGraphTools(agent: AgentSettings | undefined, on: boolean): AgentSettings {
	return { ...agent, graphTools: { enabled: on } };
}

/** Compose: one slot's model/thinking pick. All-empty = the slot is
 *  removed (unset); an empty model keeps the stored one; empty thinking =
 *  the level is unset (the engine resolves its default). Per-field
 *  independence, same as the schema's ModelSlot. Pure — exported for tests. */
export function composeSlotModel(
	models: ModelsSettings | undefined,
	slot: ModelSlotName,
	provider: string,
	id: string,
	thinking: string,
): ModelsSettings {
	const prev = models?.[slot];
	const next = { ...models };
	if (!provider && !id && !thinking) {
		delete next[slot];
		return next;
	}
	next[slot] = {
		...(prev?.cacheRetention !== undefined ? { cacheRetention: prev.cacheRetention } : {}),
		...(provider && id ? { model: { provider, id } } : prev?.model ? { model: prev.model } : {}),
		...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
	};
	return next;
}

/** Retention is slot-only; selecting Pi default removes the field entirely. */
export function composeSlotCacheRetention(models: ModelsSettings | undefined, slot: ModelSlotName, value: CacheRetention | undefined): ModelsSettings {
	const next = { ...models?.[slot] };
	if (value === undefined) delete next.cacheRetention;
	else next.cacheRetention = value;
	return { ...models, [slot]: next };
}

/** Compose: the search-engine preference. null = the explicit pin is
 *  REMOVED (auto-activation takes over — the schema's resting state).
 *  Pure — exported for tests. */
export function composeSearchEngine(
	agent: AgentSettings | undefined,
	engine: SearchEngineId | null,
): AgentSettings {
	if (engine === null) {
		if (!agent?.search) return { ...agent };
		const { search: _drop, ...rest } = agent;
		return { ...rest } as AgentSettings;
	}
	return { ...agent, search: { engine } };
}

/** The indicator under a row whose override IS the version in use: shown
 *  when the switch is on, and NOTHING when the default composes, even if a
 *  saved override sits on disk unused — the switch visibly controls this
 *  line. Exported for the pin. */
export const PROMPT_IN_USE_HINT = "Your version is in use";

/** Prompt sections in display order; Shared is deduplicated and last. */
export interface PromptSection {
	id: keyof PromptView | "shared";
	label: string;
	segments: PromptRow[];
}

/** Keep each agent's own assembly order, then list shared chunks once.
 *  Usage is derived from the API's actual per-agent membership, never a
 *  second copy of the runtime's Practice shared-fragment allowlist.
 *  Pure — exported for tests. */
export function sectionedSegments(view: PromptView): PromptSection[] {
	const agents = [
		{ id: "teacher", label: "Teacher" },
		{ id: "prober", label: "Prober" },
		{ id: "practice", label: "Practice" },
	] as const;
	const shared = new Map<string, SegmentInfo>();
	for (const { id } of agents) {
		for (const segment of view[id]) {
			if (segment.shared && !shared.has(segment.path)) shared.set(segment.path, segment);
		}
	}
	return [
		...agents.map(({ id, label }) => ({ id, label, segments: view[id].filter((s) => !s.shared) })),
		{
			id: "shared",
			label: "Shared",
			segments: [...shared.values()].map((segment) => {
				const users = agents.filter(({ id }) => view[id].some((s) => s.path === segment.path)).map(({ label }) => label);
				const usage = users.length > 1 ? `${users.slice(0, -1).join(", ")} and ${users.at(-1)}` : users[0];
				return { ...segment, usageHint: `Used by ${usage}` };
			}),
		},
	];
}

/** Compose: one prompt switch. on = explicit true; off = key REMOVED
 *  (absent = off is the schema's resting state; explicit false is the
 *  same thing but noisier). Pure — tests. */
export function composePromptSwitch(agent: AgentSettings | undefined, path: string, on: boolean): AgentSettings {
	const prompts = { ...agent?.prompts };
	if (on) prompts[path] = true;
	else delete prompts[path];
	return { ...agent, prompts };
}

/** The collapsed select look — a button that opens the shared
 *  model-picker dropdown. */
function MenuTrigger({
	value,
	emptyLabel,
	ariaLabel,
	testid,
	open,
	onClick,
	widthClass,
	disabled,
	hint,
}: {
	value: string;
	hint?: string;
	/** What the trigger shows when there is no override ("Default"). */
	emptyLabel: string;
	ariaLabel: string;
	testid: string;
	open: boolean;
	onClick: () => void;
	/** The thinking trigger is FIXED width (varying values would shift the
	 *  row mid-edit); the model trigger takes its width as a MINIMUM — its
	 *  values genuinely vary in length. */
	widthClass: string;
	/** The no-key search state grays the whole row; the trigger follows. */
	disabled?: boolean;
}) {
	const button = (
		<SettingsMenuTrigger
			value={value || emptyLabel}
			aria-label={ariaLabel}
			aria-expanded={open}
			data-testid={testid}
			onClick={() => {
				if (!disabled) onClick();
			}}
			unavailable={disabled}
			className={widthClass}
		/>
	);
	return hint ? <Hint label={hint}>{button}</Hint> : button;
}

/* The section's dropdowns all mount the shared MenuShell: portaled to
 * document.body, fixed-anchored to the open trigger by
 * testid (the section's one-ref pattern), opening DOWN with the shell's
 * viewport cap and auto-flip. data-lh-menu rides the shell — the
 * outside-click contract's exemption mark. */

export function AgentSection({
	agent,
	fileAccessError,
	models,
	graph,
	compaction,
	onSectionChange,
	onModelsChange,
	onCompactionChange,
}: {
	agent: AgentSettings | undefined;
	fileAccessError?: string | null;
	/** The `models` section (slot pins — engine-level, PUT /api/settings/models). */
	models: ModelsSettings | undefined;
	/** The `graph` section — READ ONLY here: the graphTools row composes its
	 *  master switch (graph.enabled off dims + disables the row; the
	 *  effective gate is server-side, per-turn fresh). */
	graph: GraphSettings | undefined;
	/** The `compaction` section — its own PUT (the threshold is engine
	 *  behavior, not an agent-section key). */
	compaction: CompactionSettings | undefined;
	/** Writes the composed WHOLE agent section (replace-PUT discipline). */
	onSectionChange: (next: AgentSettings) => void;
	/** Writes the composed models section (slots — replace-PUT discipline). */
	onModelsChange: (next: ModelsSettings) => void;
	/** Writes the whole compaction section (replace-PUT discipline). */
	onCompactionChange: (next: CompactionSettings) => void;
}) {
	// The shared catalog seeds the first frame and refreshes per mount and
	// keys/models signal. Settings props still own saved selections/levels.
	const { catalog: body, failed: catalogFailed, refresh: refreshCatalog } = useModelCatalog();
	const catalog = body?.models;
	const slots = body?.slots;
	/** The live search state (/api/search) — the row's reason line. */
	const [folderInput, setFolderInput] = useState("");
	const [folderError, setFolderError] = useState<string | null>(null);
	const [search, setSearch] = useState<{ available: boolean; engine: string | null; reason: string } | null>(null);
	/** Which search engines have a key (/api/keys) — the no-keys-anywhere
	 *  state grays the row; per-engine marks ride the menu rows. */
	const [engineKeys, setEngineKeys] = useState<Partial<Record<SearchEngineId, boolean>>>({});
	const [prompts, setPrompts] = useState<PromptView | null>(null);
	const [openSegment, setOpenSegment] = useState<string | null>(null);
	const [segmentDraft, setSegmentDraft] = useState<Record<string, string>>(() => ({ ...segmentDrafts }));
	const [segmentStatus, setSegmentStatus] = useState<string | null>(null);
	/** One open dropdown for the whole section: which slot (or the search
	 *  row), which kind. */
	const [openMenu, setOpenMenu] = useState<{ target: ModelSlotName | "search"; kind: "model" | "thinking" | "engine" | "cache" } | null>(null);
	const [advancedModels, setAdvancedModels] = useState(false);
	const menuAnchorRef = useRef<HTMLSpanElement>(null);

	const refreshSearch = () =>
		fetch("/api/search")
			.then((r) => r.json())
			.then((body: { available: boolean; engine: string | null; reason: string }) => setSearch(body))
			.catch(() => setSearch(null));

	/** Re-read the prompt-segment view: its `enabled` flags DERIVE from
	 *  the settings record's agent switches (the toggle's truth lives
	 *  here, not in the `agent` prop), so an agent-section write must
	 *  re-read it or the toggle keeps painting its pre-write state until
	 *  a remount. Keeps the last-good view on a failed re-read (the
	 *  initial mount fetch below owns the loading/null state). */
	const readPrompts = useCallback(() => {
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: PromptView) => setPrompts(body))
			.catch(() => {});
	}, []);

	useSettingsSaved((section) => {
		// The prompt switches write through the agent section, and this view
		// is the toggles' truth — every settings reader re-reads on save.
		if (section === "agent") readPrompts();
	});

	useEffect(() => {
		fetch("/api/settings/prompts")
			.then((r) => r.json())
			.then((body: PromptView) => setPrompts(body))
			.catch(() => setPrompts(null));
		fetch("/api/keys")
			.then((r) => r.json())
			.then((body: { keys: { id: string; present: boolean }[] }) => {
				const present: Partial<Record<SearchEngineId, boolean>> = {};
				for (const { id, envVar } of SEARCH_ENGINES) {
					present[id] = body.keys.some((k) => k.id === envVar && k.present);
				}
				setEngineKeys(present);
			})
			.catch(() => {});
	}, []);

	// The reason line re-reads /api/search AFTER an engine write lands —
	// the write updates the `agent` prop (the dialog's record mirror), so
	// keying on the pin avoids the race where the fetch beat the PUT and
	// the hint contradicted the trigger it sits under.
	useEffect(() => {
		refreshSearch();
	}, [agent?.search?.engine]);

	// Any click outside the open menu, or Esc, closes it (bindSettingsMenuDismiss).
	useEffect(() => {
		if (openMenu === null) return;
		return bindSettingsMenuDismiss(menuAnchorRef, () => setOpenMenu(null));
	}, [openMenu]);

	async function saveSegment(path: string, text: string) {
		setSegmentStatus(null);
		const res = await fetch(`/api/settings/prompts/${path}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text }),
		});
		if (!res.ok) {
			setSegmentStatus(`Save failed: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
			return;
		}
		readPrompts();
		setSegmentStatus("Saved");
		// Auto-on: writing an override and putting it to work are ONE action
		// (a save with the switch off would change nothing). The file exists
		// now, so the ON switch the agent-section validation requires is legal;
		// the order (file, then switch) is the safe one. Saving an edit while
		// already on rides through — the switch write is idempotent.
		if (agent?.prompts?.[path] !== true) {
			onSectionChange(composePromptSwitch(agent, path, true));
		}
	}

	async function deleteSegment(path: string) {
		setSegmentStatus(null);
		const res = await fetch(`/api/settings/prompts/${path}`, { method: "DELETE" });
		if (!res.ok) {
			setSegmentStatus(`Delete failed: ${res.status}`);
			return;
		}
		// Auto-off — the mirror of save's auto-on: deleting the file while the
		// switch is on would orphan an ON record switch (the agent-section
		// validation would 400 every later write while the UI's toggle can no
		// longer reach OFF). Composing the OFF here keeps the record clean.
		if (agent?.prompts?.[path] === true) {
			onSectionChange(composePromptSwitch(agent, path, false));
		}
		readPrompts();
		setSegmentStatus("Deleted");
	}

		/** The search-engine menu row — label + the quiet live-key mark. */
	const engineOption = (
		id: SearchEngineId | "auto",
		label: string,
		active: boolean,
		live: boolean | null,
		onPick: () => void,
	) => (
		<button
			key={id}
			type="button"
			data-testid={`engine-option-${id}`}
			onClick={onPick}
			className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted ${
				active ? "bg-muted/60 text-card-foreground" : "text-card-foreground"
			}`}
		>
			<span>{label}</span>
			<span className="text-muted-foreground">
				{live === null ? (active && <span aria-hidden>✓</span>) : live ? <span aria-hidden>✓ key</span> : <span aria-hidden>· no key</span>}
			</span>
		</button>
	);

	const segmentRow = (info: PromptRow) => {
		const fileExists = info.overrideText !== null;
		const open = openSegment === info.path;
		// The Save affordance: clickable only when the draft differs from
		// what's on disk; an unchanged editor shows a grayed, inert Save.
		const draft = segmentDraft[info.path] ?? info.overrideText ?? "";
		// Blank text never saves: it would blank the segment out of the prompt.
		const dirty = draft !== (info.overrideText ?? "") && draft.trim() !== "";
		return (
			<div key={info.path} data-testid={`prompt-segment-${info.path}`}>
				<SettingsRow
					label={info.path}
					// The small text: the shared-chunk usage, plus
					// PROMPT_IN_USE_HINT when the switch is on.
					hint={[info.usageHint, info.enabled ? PROMPT_IN_USE_HINT : undefined].filter(Boolean).join(" · ") || undefined}
					testid={`prompt-row-${info.path}`}
				>
					{/* ONLY the toggle dims without an override file —
					    the file name above stays full-contrast. */}
					<span className={fileExists ? undefined : "opacity-40"}>
						<Toggle
							checked={info.enabled}
							disabled={!fileExists}
							label={`prompt ${info.path}`}
							onChange={(on) => onSectionChange(composePromptSwitch(agent, info.path, on))}
						/>
					</span>
				</SettingsRow>
				<button
					type="button"
					onClick={() => {
						setOpenSegment(open ? null : info.path);
						setSegmentStatus(null);
					}}
					className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
				>
					{open ? "Hide text" : "Show text"}
				</button>
				{open && (
					<div className="mt-1 flex flex-col gap-2">
						<div>
							<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">Source</p>
							<textarea
								readOnly
								value={info.sourceText}
								aria-label="The original instructions"
								className="h-24 w-full resize-y rounded-sm border border-border bg-muted p-2 font-ui text-xs text-muted-foreground"
							/>
						</div>
						<div>
							<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">Override</p>
							<textarea
								value={segmentDraft[info.path] ?? info.overrideText ?? ""}
								onChange={(e) => {
									segmentDrafts[info.path] = e.target.value;
									setSegmentDraft({ ...segmentDraft, [info.path]: e.target.value });
								}}
								aria-label="Your version of the instructions"
								placeholder="Add your own instructions…"
								className="h-24 w-full resize-y rounded-sm border border-border bg-background p-2 font-ui text-xs text-foreground outline-none"
							/>
						</div>
						<div className="flex items-center gap-3">
							<button
								type="button"
								disabled={!dirty}
								onClick={() => void saveSegment(info.path, segmentDraft[info.path] ?? "")}
								className={
									dirty
										? "text-xs text-foreground underline-offset-2 hover:underline"
										: "cursor-not-allowed text-xs text-muted-foreground/40 underline-offset-2"
								}
							>
								Save
							</button>
							{fileExists && (
								<button
									type="button"
									onClick={() => void deleteSegment(info.path)}
									className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-red-500 hover:underline"
								>
									Delete
								</button>
							)}
							{/* The quiet inline confirmation next to the action
							    (no file paths in user-facing status). One editor is
							    open at a time (openSegment), so one shared status
							    reads unambiguously. */}
							{segmentStatus && (
								<p className="text-xs text-muted-foreground/70" data-testid="segment-status">
									{segmentStatus}
								</p>
							)}
						</div>
					</div>
				)}
			</div>
		);
	};



	// Resolved through the SAME core resolver the server's effective
	// settings use: the hint and placeholder report exactly the number the
	// trigger waits for.
	const resolvedCompaction = resolveSettings(
		compaction === undefined ? null : { version: 1, compaction },
	).compaction;

	return (
		<>
			<SettingsGroup label="Models" testid="group-models">
				<button
					type="button"
					data-testid="models-advanced"
					aria-expanded={advancedModels}
					onClick={() => { setAdvancedModels(!advancedModels); setOpenMenu(null); }}
					className="mb-1 self-start text-xs text-muted-foreground hover:text-foreground"
				>{advancedModels ? "Hide advanced settings" : "Show advanced settings"}</button>
				{catalogFailed && <p role="alert" className="text-xs text-red-400">Model catalog could not be loaded. Check the connection and retry. <button type="button" className="underline" onClick={refreshCatalog}>Retry</button></p>}
				{MODEL_SLOTS.map((slot) => {
					const override = models?.[slot];
					const modelId = override?.model?.id ?? "";
					const provider = override?.model?.provider ?? "";
					const thinking = override?.thinkingLevel ?? "";
					const pin = slots?.[slot];
					// The model whose levels govern the thinking list: the stored
					// pick, else the catalog's resolved slot (when it's in the
					// federated catalog); the standard ladder as the last fallback.
					const coord = override?.model ?? pin?.model;
					const chosen = coord ? catalog?.find((m) => m.id === coord.id && m.provider === coord.provider) : undefined;
					const levels = chosen ? chosen.supportedLevels : THINKING_LEVELS;
					const thisMenuOpen = openMenu?.target === slot ? openMenu.kind : null;
					// A saved model whose provider has no key can't run.
					const disconnected = !!coord && !!body && !body.providers.some((p) => p.id === coord.provider && p.keyPresent);
					return (
						<SettingsRow
							key={slot}
							label={SLOT_META[slot].label}
							hint={disconnected ? <>{SLOT_META[slot].roster} · <span data-testid={`slot-disconnected-${slot}`} className="text-red-500">provider not connected</span></> : SLOT_META[slot].roster}
							testid={`slot-row-${slot}`}
						>
							{/* The anchor for the outside-click contract is the
							    span holding BOTH triggers of the open menu. */}
							<span
								ref={thisMenuOpen ? menuAnchorRef : undefined}
								className={`relative flex items-center gap-2 ${advancedModels ? "shrink-0" : ""}`}
								onKeyDown={(event) => {
									// Portal events bubble here too: close this menu, not the dialog.
									if (thisMenuOpen === "cache" && event.key === "Escape") {
										event.preventDefault(); event.stopPropagation(); setOpenMenu(null);
									}
								}}
							>
								{slot !== "strong" && <><ChatGPTBackgroundAccess provider={coord?.provider} /><NativeSubscriptionBackgroundAccess provider={coord?.provider} /></>}
								<MenuTrigger
									value={modelId ? prettyModel(modelId) : ""}
									hint={modelId ? `${provider}:${modelId}` : undefined}
									emptyLabel="—"
									ariaLabel={`${SLOT_META[slot].label} model`}
									testid={`slot-model-${slot}`}
									open={thisMenuOpen === "model"}
									onClick={() => setOpenMenu(thisMenuOpen === "model" ? null : { target: slot, kind: "model" })}
									widthClass="min-w-20"
								/>
								<MenuTrigger
									// No stored level + a known model → the RESOLVED level (the
									// ordering's first supported — what the engine build runs).
									// Display-only until a pick writes.
									value={thinking || (chosen ? defaultOrderLevel(levels) : "")}
									emptyLabel="—"
									ariaLabel={`${SLOT_META[slot].label} thinking`}
									testid={`slot-thinking-${slot}`}
									open={thisMenuOpen === "thinking"}
									onClick={() => setOpenMenu(thisMenuOpen === "thinking" ? null : { target: slot, kind: "thinking" })}
									widthClass="w-20"
								/>
								{advancedModels && <MenuTrigger
									value={cacheRetentionLabel(override?.cacheRetention)}
									emptyLabel="Cache: default"
									ariaLabel={`${SLOT_META[slot].label} cache retention`}
									testid={`slot-cache-${slot}`}
									open={thisMenuOpen === "cache"}
									disabled={!override?.model}
									onClick={() => setOpenMenu(thisMenuOpen === "cache" ? null : { target: slot, kind: "cache" })}
									widthClass="w-40"
								/>}
								{advancedModels && thisMenuOpen === "cache" && <MenuShell
									preferredSide="down"
									anchorTestid={`slot-cache-${slot}`}
									testid={`slot-cache-menu-${slot}`}
									menuClass="flex w-80 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
								>
									<CacheRetentionMenu value={override?.cacheRetention} provider={coord?.provider} modelId={coord?.id} onPick={(value) => {
										onModelsChange(composeSlotCacheRetention(models, slot, value));
										setOpenMenu(null);
									}} />
								</MenuShell>}
								{thisMenuOpen === "model" && (
									<MenuShell
										preferredSide="down"
											anchorTestid={`slot-model-${slot}`}
										testid={`slot-model-menu-${slot}`}
										menuClass="flex w-[22rem] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
									>
										<ModelMenuList
											models={catalog ?? undefined}
											effectiveId={modelId}
											effectiveProvider={provider}
											vision={slot === "vision"}
											onPick={(entry) => {
												// Auto-populate: the fresh pick writes a level — the stored
												// one rides as-is (the write clamps server-side), else the
												// ordering's level.
												const next = populateLevel(thinking || undefined, entry.supportedLevels);
												onModelsChange(composeSlotModel(models, slot, entry.provider, entry.id, next));
												setOpenMenu(null);
											}}
											footer={
												catalog && catalog.length === 0
													? "No models — add a provider key in Providers"
													: "Runs every agent of this tier"
											}
										/>
									</MenuShell>
								)}
								{thisMenuOpen === "thinking" && (
									<MenuShell
										preferredSide="down"
											anchorTestid={`slot-thinking-${slot}`}
										testid={`slot-thinking-menu-${slot}`}
										menuClass="flex w-44 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
									>
										<ThinkingMenuList
											levels={levels.map(String)}
											// The ✓ sits on the RESOLVED level for unset records — the
											// same one the trigger shows.
											effectiveLevel={thinking || (chosen ? defaultOrderLevel(levels) : undefined)}
											onPick={(level) => {
												onModelsChange(composeSlotModel(models, slot, provider, modelId, level));
												setOpenMenu(null);
											}}
										/>
									</MenuShell>
								)}
							</span>
						</SettingsRow>
					);
				})}
			</SettingsGroup>

			<SettingsGroup label="Tools" testid="group-tools">
				{/* The prober's graph tools: FIRST row of the group — it
				    gates tool registration, so it lives in Tools but NOT in
				    the tool-toggles list (its own key, agent.graphTools). */}
				{(() => {
					const graphOn = graph?.enabled ?? true;
					return (
						<SettingsRow
							label="Graph tools"
							hint={graphOn ? "Lets the tutor consult your knowledge map between sessions" : "Graph is disabled"}
							testid="graph-tools-row"
							dimmed={!graphOn}
						>
							<Toggle
								checked={agent?.graphTools?.enabled ?? true}
								disabled={!graphOn}
								label="graph tools"
								onChange={(on) => onSectionChange(composeGraphTools(agent, on))}
							/>
						</SettingsRow>
					);
				})()}
				{/* The quizzing mechanic: segmented — exactly one
				    of Multiple choice / Free recall is active; the choice swaps which
				    quizzing tool BOTH agents carry (prober checks + teach checks).
				    Persisted as agent.tools.explain; absent = Multiple choice. */}
				{(() => {
					const free = agent?.tools?.explain === true;
					return (
						<SettingsRow
							label="Quizzing"
							hint="How both tutors check your understanding"
							testid="quiz-mechanics-row"
						>
							<div
								role="radiogroup"
								aria-label="Quizzing mechanics"
								className="flex rounded-lg border border-border/60 bg-muted/30 p-0.5"
								>
								{(["choice", "free"] as const).map((m) => {
									const active = m === "free" ? free : !free;
									return (
										<button
											key={m}
											type="button"
											role="radio"
											aria-checked={active}
											data-testid={`quiz-mechanics-${m}`}
											onClick={() => onSectionChange(composeQuizMechanics(agent, m))}
											className={cn(
												"h-8 rounded-md px-3 text-sm font-medium transition-colors",
												active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
											)}
										>
											{m === "choice" ? "Multiple choice" : "Free recall"}
										</button>
									);
								})}
							</div>
						</SettingsRow>
					);
				})()}
				{TOGGLE_TOOLS.map((id) => (
					<SettingsRow
						key={id}
						label={`Tool · ${id}`}
						testid={`tool-row-${id}`}
					>
						<Toggle
							checked={agent?.tools?.[id] ?? true}
							label={`tool ${id}`}
							onChange={(on) => onSectionChange(composeTool(agent, id, on))}
						/>
					</SettingsRow>
				))}
				{(() => {
					const folders = agent?.fileAccess?.folders ?? [];
					const restricted = Boolean(fileAccessError) || agent?.fileAccess?.restricted === true;
					const effectiveAgent = fileAccessError ? { ...agent, fileAccess: { restricted: true, folders } } : agent;
					const addFolder = () => {
						const next = normalizeFolder(folderInput);
						if (!isFolderEntry(next)) { setFolderError("Enter an absolute path or ~/folder."); return; }
						if (isRootFolder(next)) { setFolderError("Choose a specific folder, not the whole disk."); return; }
						if (folders.map(normalizeFolder).includes(next)) { setFolderError("That folder is already listed."); return; }
						onSectionChange(composeAddFolder(effectiveAgent, next));
						setFolderInput("");
						setFolderError(null);
					};
					return (
						<div data-testid="file-access-row" className="flex flex-col gap-2">
							<SettingsRow label="File access" hint={!restricted
								? "Broad local source access, except protected locations"
								: folders.length ? "Only listed folders and subfolders, plus uploaded attachments."
									: "Restricted: only uploaded attachments. Add a folder to allow more."}>
								<div className="flex items-center gap-2 text-xs">
									<span>Restrict to listed folders</span>
									<Toggle checked={restricted} label="Restrict to listed folders" onChange={(on) => onSectionChange(composeFileRestriction(effectiveAgent, on))} />
								</div>
							</SettingsRow>
							{fileAccessError && <p role="alert" data-testid="file-access-config-error" className="text-xs text-red-500">{fileAccessError}</p>}
							<div className="flex gap-2 pl-3">
								<input value={folderInput} aria-label="Allowed folder path" data-testid="file-access-add" placeholder="Absolute path or ~/folder"
									onChange={(event) => { setFolderInput(event.target.value); setFolderError(null); }}
									onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addFolder(); } }}
									className="min-w-0 flex-1 rounded-sm border border-border bg-background px-2 py-1 font-ui text-xs" />
								<button type="button" data-testid="file-access-add-button" disabled={!folderInput.trim()} onClick={addFolder} className="rounded-sm border border-border px-2 text-xs disabled:opacity-40">Add folder</button>
							</div>
							{folderError && <p role="alert" data-testid="file-access-input-error" className="pl-3 text-xs text-red-500">{folderError}</p>}
							{folders.map((folder) => (
								<div key={folder} data-testid="file-access-folder" className="flex items-center justify-between gap-4 pl-3 text-xs">
									<span title={folder} className="min-w-0 truncate font-ui text-muted-foreground">{folder}</span>
									<button type="button" aria-label={`Remove ${folder}`} data-testid="file-access-remove"
										onClick={() => onSectionChange(composeRemoveFolder(effectiveAgent, folder))}
										className="rounded-sm px-1.5 text-muted-foreground hover:text-foreground">Remove</button>
								</div>
							))}
						</div>
					);
				})()}
				{(() => {
					const engine = agent?.search?.engine ?? null;
					const anyKey = SEARCH_ENGINES.some(({ id }) => engineKeys[id] === true);
					const open = openMenu?.target === "search";
					return (
						<SettingsRow
							label="Search engine"
							hint={search?.reason ?? undefined}
							testid="search-engine-row"
							dimmed={!anyKey}
						>
							<span ref={open ? menuAnchorRef : undefined} className="relative flex items-center gap-2">
								<MenuTrigger
									value={SEARCH_ENGINES.find(({ id }) => id === engine)?.label ?? ""}
									emptyLabel="Automatic"
									ariaLabel="Search engine"
									testid="search-engine-trigger"
									open={open}
									onClick={() => setOpenMenu(open ? null : { target: "search", kind: "engine" })}
									widthClass="min-w-20"
									disabled={!anyKey}
								/>
								{open && (
									<MenuShell
										preferredSide="down"
											anchorTestid="search-engine-trigger"
										testid="search-engine-menu"
										menuClass="flex w-44 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
									>
										{engineOption("auto", "Automatic", engine === null, null, () => {
											onSectionChange(composeSearchEngine(agent, null));
											setOpenMenu(null);
										})}
										{SEARCH_ENGINES.map(({ id, label }) =>
											engineOption(id, label, engine === id, engineKeys[id] ?? false, () => {
												onSectionChange(composeSearchEngine(agent, id));
												setOpenMenu(null);
											}),
										)}
									</MenuShell>
								)}
							</span>
						</SettingsRow>
					);
				})()}
			</SettingsGroup>

			<FlashcardAgentSection agent={agent} onChange={onSectionChange}/>

			<ModelInstructionsSection agent={agent} catalog={catalog ?? undefined} onChange={onSectionChange} />

			<SettingsGroup label="Context" testid="group-context">
				<SettingsRow
					label="Compaction threshold"
					hint={`${resolvedCompaction.thresholdTokens} tok`}
					testid="compaction-row-threshold"
				>
					<CommitInput
						type="number"
						value={String(compaction?.thresholdTokens ?? "")}
						placeholder={String(resolvedCompaction.thresholdTokens)}
						ariaLabel="compaction threshold"
						testid="input-compaction-threshold"
						onCommit={(v) => {
							// Empty = factory default: absence is the unset for numbers.
							if (v === "") {
								onCompactionChange({ ...compaction, thresholdTokens: undefined });
								return;
							}
							const n = Number(v);
							if (!Number.isFinite(n) || n <= 0) return "Enter a number of tokens, or leave it empty for the default.";
							// Mirror the server's floor (anti-churn: each compaction
							// keeps a ~20k-token tail) and ceiling.
							onCompactionChange({
								...compaction,
								thresholdTokens: Math.min(COMPACTION_THRESHOLD_MAX, Math.max(COMPACTION_THRESHOLD_FLOOR, Math.round(n))),
							});
						}}
					/>
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup label="System prompts" testid="group-prompts">
				{prompts === null ? (
					<p className="text-xs text-muted-foreground/70">Loading prompt segments…</p>
				) : (
					<div className="flex flex-col gap-4">
						{/* Teacher, Prober, Practice, Shared — shared chunks once,
						    each agent's own section in prompt-assembly order. */}
						{sectionedSegments(prompts).map((section) => (
							<div key={section.id} data-testid={`prompt-section-${section.id}`}>
								<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">
									{section.label}
								</p>
								<div className="flex flex-col gap-2">
									{section.segments.map((info) => segmentRow(info))}
								</div>
							</div>
						))}
					</div>
				)}
			</SettingsGroup>
		</>
	);
}
