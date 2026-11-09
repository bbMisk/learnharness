"use client";
/**
 * The first-run setup flow (model-slots wave, 2026-09-20, owner design
 * "A — composer CTA + send interception"): chats cannot start until the
 * user has picked all three model slots — there are no defaults for 33
 * providers. The graph view's new-session dock (the app's home, where
 * chats start) shows a "Set up your models" CTA while unconfigured;
 * submitting a topic — or sending on /chat/new — opens THIS dialog with
 * the draft preserved; Save stores the slots — the draft WAITS in the
 * composer, the learner sends it themselves (owner ruling 2026-10-09:
 * saving models must never send the message).
 *
 * STAGED BY DEPENDENCY (owner, 2026-09-20: "first keys, then models —
 * there's no point presenting the model picker before the user has set a
 * key because there are no models to pick then"):
 *   Unknown catalog — neutral loading (or error/Retry), never a key screen.
 *   Stage 1 — no keyed provider or saved selection: a SELF-CONTAINED first-key screen
 *     (zero-keys wave, owner 2026-09-25): provider picker + one key
 *     input + save via PUT /api/keys/:id. The dialog STAYS MOUNTED —
 *     saving dispatches the "keys" signal, the fetch effect re-runs on
 *     it, and the stage flips to the pickers on its own. No Settings
 *     round-trip anymore; the draft lives in the caller's state,
 *     untouched throughout.
 *   Stage 2 — Strong → Cheap → Vision pickers over the FEDERATED catalog
 *     (keyed providers only), the vision slot filtered to image-capable
 *     models, in the app's shared dropdown language (ModelMenuList).
 *     Saved disconnected selections and edits are retained internally in
 *     the exclusive provider stage. Connecting the provider every saved slot uses
 *     closes setup; otherwise every slot without a connected provider is
 *     marked needed and must be picked again.
 *     All three required (owner: no skip, no defaults); Save PUTs the
 *     models section and reports onDone(models).
 *
 * Closable without configuring (Esc/backdrop/✕) — browsing the app stays
 * possible; the GATE is the send interception, not the dialog. The
 * settings-dialog visual language: dim backdrop, border rounded-md card,
 * CMU title, z-50.
 */

import { useEffect, useRef, useState } from "react";
import { isComposing } from "@/components/ime";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { focusComposer, useFocusReturn } from "@/components/focus-return";
import type React from "react";
import { type ModelCatalogEntry, type ModelSlotName, type ModelsSettings, COMPACTION_THRESHOLD_FLOOR, CUSTOM_PROVIDER } from "@/src/core";
import { prettyModel } from "@/components/usage-format";
import { ModelMenuList } from "@/components/settings/model-menu";
import { MenuShell } from "@/components/menu-shell";
import { notifySettingsSaved, onSettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { useModelCatalog } from "@/components/model-catalog";
import { savedSlotsConnected } from "@/components/setup-cta";
import { Hint } from "@/components/ui/hint";
import { type ProviderKeyInfo, CUSTOM_PROVIDER_INFO, CustomEndpointSetup } from "@/components/settings/keys-section";
import { ProviderMenuList } from "@/components/settings/model-menu";
import { ChatGPTBackgroundAccess } from "@/components/settings/chatgpt-connection";
import { NativeSubscriptionBackgroundAccess, SubscriptionConnections } from "@/components/settings/subscription-connections";
import { populateLevel, THINKING_LABEL } from "@/components/thinking-default";
import { ThinkingMenuList } from "@/components/settings/model-menu";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** The pickers' slot identity — same roster language as the Agent
 *  section's slot rows. */
const SLOT_META: Record<ModelSlotName, { label: string; roster: string }> = {
	strong: { label: "Strong", roster: "Prober, teacher" },
	cheap: { label: "Cheap", roster: "Researcher, demo builder, extractor, auditor" },
	vision: { label: "Vision", roster: "Visual maker + PDF reader" },
};
const SLOT_ORDER: readonly ModelSlotName[] = ["strong", "cheap", "vision"];

/** The GET /api/models response fields the flow consumes. */
interface ModelsBody {
	models: ModelCatalogEntry[];
	providers: { id: string; keyPresent: boolean }[];
	/** The three tiers' RESOLVED pins (BYOK: NULL per unset tier) — the
	 *  PREFILL + "needed" marks (owner, 2026-09-22): pinned tiers open
	 *  with their pick, unpinned tiers carry the mark. */
	slots?: Record<ModelSlotName, { model: { provider: string; id: string }; thinkingLevel?: ThinkingLevel } | null>;
}

/** Pure: which stage the flow opens at — no keyed provider = keys first
 *  (owner's dependency ordering). Exported for tests. */
export function setupStage(
	providers: { id: string; keyPresent: boolean }[] | null,
): "loading" | "keys" | "pickers" {
	if (providers === null) return "loading";
	return providers.some((p) => p.keyPresent) ? "pickers" : "keys";
}

type ModelSelection = Pick<ModelCatalogEntry, "provider" | "id">;

/** Saved identity is independent of selectable metadata. A disconnected
 * pin still prefills (marked needed); only the menu is restricted to the
 * live catalog. */
export function prefillFromSlots(
	models: ModelCatalogEntry[],
	slots: Record<ModelSlotName, { model: { provider: string; id: string } } | null> | undefined,
): Partial<Record<ModelSlotName, ModelSelection>> {
	const pre: Partial<Record<ModelSlotName, ModelSelection>> = {};
	for (const slot of SLOT_ORDER) {
		const pin = slots?.[slot];
		const entry = pin?.model
			? models.find((m) => m.provider === pin.model!.provider && m.id === pin.model!.id)
			: undefined;
		if (pin?.model) pre[slot] = entry ?? pin.model;
	}
	return pre;
}

/** Level prefill (chunk 2): a pinned tier opens with its STORED level
 *  as-is (Save clamps server-side if the ladder lapsed), else the
 *  ordering's level for that model — the level a fresh pick would
 *  populate (owner: the ordering's only purpose is first assignment).
 *  Exported pure for tests. */
export function prefillLevelFromPin(
	entry: ModelCatalogEntry,
	pin: { thinkingLevel?: ThinkingLevel } | null | undefined,
): ThinkingLevel {
	return populateLevel(pin?.thinkingLevel, entry.supportedLevels);
}

/** Stage 1's pure body — exported for SSR pins (the delete/settings
 *  body pattern). The wrapper owns state + effects + the portal.
 *
 * The first-key screen (owner, zero-keys wave): provider picker (the
 * app's shared dropdown language, ProviderMenuList), one paste input,
 * Save. A save that 400s keeps the line inline (the keys section's
 * shape-gates write user-facing error text). */
export function SetupKeysBody({
	providers,
	provider,
	value,
	saving,
	error,
	menuOpen,
	onToggleMenu,
	onPick,
	onValue,
	onSave,
	menuAnchor,
	isCustom,
	onCustomSaved,
}: {
	/** The full provider roster (GET /api/keys providers) — undefined
	 *  while it loads; the picker renders an honest empty state then. */
	providers: ProviderKeyInfo[] | undefined;
	/** The chosen provider; null = the picker trigger reads "Pick a
	 *  provider…". */
	provider: ProviderKeyInfo | null;
	value: string;
	saving: boolean;
	error: string | null;
	menuOpen: boolean;
	onToggleMenu: () => void;
	onPick: (p: ProviderKeyInfo) => void;
	onValue: (v: string) => void;
	onSave: () => void;
	/** The MenuShell anchor — wired by the wrapper (its triggerRef). */
	menuAnchor: React.RefObject<HTMLDivElement | null>;
	/** Chosen provider is the custom endpoint: a base URL field joins the key
	 *  field. All three optional so plain-key callers (and tests) stay unchanged. */
	isCustom?: boolean;
	onCustomSaved?: () => void;
}) {
	const keyRef = useRef<HTMLInputElement>(null);
	// A rejected key re-enables the field, which disabling had dropped focus from.
	useEffect(() => {
		if (!saving && error && (!document.activeElement || document.activeElement === document.body)) keyRef.current?.focus();
	}, [saving, error]);
	return (
		<div className="flex flex-col gap-3 px-6 py-5" data-testid="setup-stage-keys">
			<p className="text-xs text-muted-foreground">
				Choose your AI provider and paste its API key. You’ll pick your models next.
			</p>
			<div className="flex flex-col gap-2">
				<div ref={menuAnchor} className="relative max-w-96">
					<button
						type="button"
						aria-label="Provider"
						data-testid="setup-key-provider"
						aria-expanded={menuOpen}
						onClick={onToggleMenu}
						className="flex h-7 w-full items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
					>
						<span className="min-w-0 flex-1 truncate text-left">{provider ? provider.label : "Pick a provider…"}</span>
						<span aria-hidden className="text-muted-foreground">
							▾
						</span>
					</button>
					{menuOpen && (
						<MenuShell
							anchorRef={menuAnchor}
							testid="setup-key-provider-menu"
							preferredSide="down"
							align="left"
							menuClass="flex w-[22rem] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
						>
							<ProviderMenuList providers={providers ?? []} onPick={onPick} />
						</MenuShell>
					)}
				</div>
				{provider && (isCustom ? <CustomEndpointSetup onSaved={onCustomSaved ?? onSave} /> : (
					<div className="flex max-w-96 flex-col gap-2">
						<div className="flex items-center gap-2">
							<input
								type="password"
								autoComplete="off"
								value={value}
								onChange={(e) => onValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && value.trim()) onSave();
								}}
								placeholder="Paste key…"
								aria-label={`${provider.label} key`}
								ref={keyRef}
								data-testid="setup-key-input"
								disabled={saving}
								autoFocus
								className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50"
							/>
							<button
								type="button"
								onClick={onSave}
								disabled={saving || !value.trim()}
								data-testid="setup-key-save"
								className="shrink-0 rounded-sm border border-border bg-background px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40"
							>
								{saving ? "Saving…" : "Save key"}
							</button>
						</div>
					</div>
				))}
				{error && (
					<p role="alert" data-testid="setup-key-error" className="text-xs text-red-400">
						{error}
					</p>
				)}
			</div>
			<div className="mt-2 border-t border-border/60 pt-4"><h3 className="mb-3 font-ui text-xs text-muted-foreground">Subscriptions</h3><SubscriptionConnections setup /></div>
		</div>
	);
}

function prefillLevels(body: ModelsBody | undefined): Partial<Record<ModelSlotName, ThinkingLevel>> {
	const levels: Partial<Record<ModelSlotName, ThinkingLevel>> = {};
	for (const slot of SLOT_ORDER) {
		const pin = body?.slots?.[slot];
		const entry = body?.models.find((m) => m.provider === pin?.model.provider && m.id === pin.model.id);
		if (pin?.thinkingLevel !== undefined) levels[slot] = pin.thinkingLevel;
		else if (entry) levels[slot] = prefillLevelFromPin(entry, pin);
	}
	return levels;
}

interface SetupDialogProps {
	open: boolean;
	onClose: () => void;
	/** Saving never sends the caller's draft. */
	onDone: (models: ModelsSettings) => void;
}

/** Picks from an open closed without saving, kept for the app session
 *  like the other drafts; any models save (here or in Settings) drops them. */
const keptPicks = {
	edited: new Set<ModelSlotName>(),
	picked: {} as Partial<Record<ModelSlotName, ModelSelection>>,
	levels: {} as Partial<Record<ModelSlotName, ThinkingLevel>>,
};

// Subscribed for the app session once the dialog first mounts: the lazy
// wrapper unmounts this module's components while setup is closed.
let keptPicksWatched = false;
function watchKeptPicks() {
	if (keptPicksWatched) return;
	keptPicksWatched = true;
	onSettingsSaved((section) => {
		if (section !== "models") return;
		keptPicks.edited.clear();
		keptPicks.picked = {};
		keptPicks.levels = {};
	});
}

export function SetupDialog(props: SetupDialogProps) {
	useEffect(watchKeptPicks, []);
	// Mount-time cache seeding avoids a key-screen first frame.
	return props.open ? <OpenSetupDialog {...props} /> : null;
}

function OpenSetupDialog({ onClose, onDone }: SetupDialogProps) {
	const backdropDismiss = useBackdropDismiss(onClose);
	const { catalog, failed, refresh } = useModelCatalog();
	const providerStageSeen = useRef(false);
	const connectionCloseRequested = useRef(false);
	const [picked, setPicked] = useState(() => ({ ...prefillFromSlots(catalog?.models ?? [], catalog?.slots), ...keptPicks.picked }));
	const [levels, setLevels] = useState(() => ({ ...prefillLevels(catalog), ...keptPicks.levels }));
	const editedSlots = useRef(keptPicks.edited);
	useEffect(() => {
		const edited = [...keptPicks.edited];
		keptPicks.picked = Object.fromEntries(edited.filter((slot) => picked[slot]).map((slot) => [slot, picked[slot]]));
		keptPicks.levels = Object.fromEntries(edited.filter((slot) => levels[slot] !== undefined).map((slot) => [slot, levels[slot]]));
	}, [picked, levels]);
	// Closing hands focus back to whatever held it on open, else (nothing did,
	// or a key save retired the pill) to the page's typing target. A models
	// save retires the setup pill too, so focus on the pill goes there as well.
	useFocusReturn(false, focusComposer);
	const saved = useRef(false);
	useEffect(() => () => {
		const at = document.activeElement;
		if (saved.current && (!at || at === document.body || at.closest('[data-testid="setup-cta"], [data-testid="setup-cta-keys"]'))) focusComposer();
	}, []);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [openMenu, setOpenMenu] = useState<{ slot: ModelSlotName; kind: "model" | "thinking" } | null>(null);
	// Stage 1's first-key screen (zero-keys wave): the provider roster,
	// the chosen provider + pasted value, its busy/error pair, and its own
	// menu-open bit (the slot menus' dismissal machinery covers it too —
	// see the trigger testid branch below).
	const [keyProviders, setKeyProviders] = useState<ProviderKeyInfo[] | undefined>(undefined);
	const [keyProvider, setKeyProvider] = useState<ProviderKeyInfo | null>(null);
	const [keyValue, setKeyValue] = useState("");
	const [keySaving, setKeySaving] = useState(false);
	const [keyError, setKeyError] = useState<string | null>(null);
	const [keyMenuOpen, setKeyMenuOpen] = useState(false);
	// Stage 1's provider-picker trigger wrapper — the shared shell's anchor.
	// Stage 2's slot menus anchor by anchorTestid instead — see the slot
	// MenuShell below for why a freshly attached ref cannot work there.
	const keyTriggerRef = useRef<HTMLDivElement>(null);

	// The keys signal (zero-keys wave): keys-section saves/deletes AND
	// THIS dialog's own first-key save dispatch it; the fetch effect below
	// re-runs on it, so saving a key widens the catalog. Incomplete saved
	// slots advance to pickers; complete saved slots just close setup.
	const [keysTick, setKeysTick] = useState(0);
	useSettingsSaved((section) => {
		if (section === "keys") setKeysTick((t) => t + 1);
	});

	useEffect(() => {
		let cancelled = false;
		fetch("/api/keys")
			.then((r) => r.json())
			.then((b: { providers?: ProviderKeyInfo[] }) => { if (!cancelled) setKeyProviders(b.providers ?? []); })
			.catch(() => { if (!cancelled) setKeyProviders([]); });
		return () => { cancelled = true; };
	}, [keysTick]);

	useEffect(() => {
		if (!catalog) return;
		const pre = prefillFromSlots(catalog.models, catalog.slots);
		const preLevels = prefillLevels(catalog);
		// Fresh metadata is always used, but a response cannot reset an
		// edited slot, including a level chosen while the request was pending.
		setPicked((prev) => {
			const next = { ...prev };
			for (const slot of SLOT_ORDER) if (!editedSlots.current.has(slot)) {
				if (pre[slot]) next[slot] = pre[slot]; else delete next[slot];
			}
			return next;
		});
		setLevels((prev) => {
			const next = { ...prev };
			for (const slot of SLOT_ORDER) if (!editedSlots.current.has(slot)) {
				if (preLevels[slot] !== undefined) next[slot] = preLevels[slot]; else delete next[slot];
			}
			return next;
		});
	}, [catalog]);

	const stage = setupStage(catalog?.providers ?? null);
	// Only a connection that makes every saved slot runnable closes setup; a
	// key for some other provider moves on to the pickers.
	const closeAfterConnection = stage === "pickers" && providerStageSeen.current && savedSlotsConnected(catalog);
	useEffect(() => {
		if (stage === "keys") providerStageSeen.current = true;
		if (closeAfterConnection && !connectionCloseRequested.current) {
			connectionCloseRequested.current = true;
			onClose(); // Connection recovery is not a model-settings save.
		}
	}, [stage, closeAfterConnection, onClose]);
	// A saved key swaps the key form for the pickers: focus moves to the first.
	useEffect(() => {
		if (stage === "pickers" && document.activeElement === document.body) document.querySelector<HTMLElement>(`[data-testid="setup-trigger-${SLOT_ORDER[0]}"]`)?.focus();
	}, [stage]);

	// Esc + outside-click — layered dismissal, closable WITHOUT
	// configuring (browsing stays possible; the gate is the send
	// interception, not this dialog). An open slot menu eats Esc first
	// (and any click outside it); only a bare Esc closes the dialog.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented || isComposing(e)) return;
			// THE ONE-ESC LAW (owner, keyboard round 2026-10-06): claim at
			// the document level before the layered dismissal — every branch
			// below acts, so the window chain (dictation → abort) must
			// never also fire. One Esc, one action.
			e.preventDefault();
			e.stopPropagation();
			if (keyMenuOpen) {
				setKeyMenuOpen(false);
				document.querySelector<HTMLElement>('[data-testid="setup-key-provider"]')?.focus();
				return;
			}
			if (openMenu !== null) setOpenMenu(null);
			else onClose();
		};
		const onPointerDown = (e: PointerEvent) => {
			if (!(e.target instanceof Element)) return;
			const t = e.target;
			if (keyMenuOpen) {
				if (t.closest("[data-lh-menu]") || t.closest('[data-testid="setup-key-provider"]')) return;
				setKeyMenuOpen(false);
			}
			if (openMenu === null) return;
			const triggerTestid =
				openMenu.kind === "model" ? `setup-trigger-${openMenu.slot}` : `setup-thinking-${openMenu.slot}`;
			if (t.closest("[data-lh-menu]") || t.closest(`[data-testid="${triggerTestid}"]`)) return;
			setOpenMenu(null);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [onClose, openMenu, keyMenuOpen]);

	// A closed slot menu (pick or Esc) hands focus back to its trigger
	// instead of dropping it to the body with the menu's search box.
	useEffect(() => {
		if (openMenu === null) return;
		const triggerTestid = openMenu.kind === "model" ? `setup-trigger-${openMenu.slot}` : `setup-thinking-${openMenu.slot}`;
		return () => {
			const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestid}"]`);
			if (trigger && (!document.activeElement || document.activeElement === document.body)) trigger.focus();
		};
	}, [openMenu]);

	// Do not briefly paint model pickers between successful connection and
	// closing an already-configured setup. No saved model/thinking writes.
	if (closeAfterConnection) return null;

	// A pick on a provider with no key can't run: it stays shown (identity
	// and thinking survive) but counts as needed. Unknown catalog: trust it.
	const runnable = (s: ModelSlotName) => !!picked[s] && (!catalog || catalog.providers.some((p) => p.id === picked[s]!.provider && p.keyPresent));
	const allPicked = SLOT_ORDER.every(runnable);

	/** Stage 1's save: PUT the pasted key, dispatch the keys signal, and
	 *  CLEAN the local key field. The fresh catalog decides whether to
	 *  close recovery or advance to the missing model slots. Shape-gate
	 *  400s keep their user-facing line inline. */
	async function saveKey() {
		if (!keyProvider || keySaving) return;
		if (!keyValue.trim()) return;
		setKeySaving(true);
		setKeyError(null);
		const res = await fetch(`/api/keys/${encodeURIComponent(keyProvider.envVar)}`, {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ value: keyValue }),
					}).catch(() => null);
		setKeySaving(false);
		if (!res || !res.ok) {
			const body = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
			setKeyError(res ? (body?.error ?? `Save failed (${res.status})`) : "Save failed. Check your connection and try again.");
			return;
		}
		setKeyProvider(null);
		setKeyValue("");
		notifySettingsSaved("keys");
	}

	async function save() {
		if (!allPicked || saving) return;
		setSaving(true);
		setError(null);
		const models: ModelsSettings = {};
		for (const slot of SLOT_ORDER) {
			const level = levels[slot];
			models[slot] = {
				// Advanced controls stay out of setup; never erase their saved choice.
				...(catalog?.slots[slot]?.cacheRetention !== undefined ? { cacheRetention: catalog.slots[slot]!.cacheRetention } : {}),
				model: { provider: picked[slot]!.provider, id: picked[slot]!.id },
				...(level ? { thinkingLevel: level } : {}),
			};
		}
		const res = await fetch("/api/settings/models", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(models),
		}).catch(() => null);
		if (!res || !res.ok) {
			setSaving(false);
			setError(res ? `Save failed: ${(await res.json().catch(() => ({}))).error ?? res.status}` : "Save failed. Check your connection and try again.");
			return;
		}
		notifySettingsSaved("models");
		saved.current = true;
		onDone(models);
	}

	const keysBody = <SetupKeysBody
		providers={keyProviders ? [...keyProviders, CUSTOM_PROVIDER_INFO] : undefined}
		provider={keyProvider}
		value={keyValue}
		saving={keySaving}
		error={keyError}
		menuOpen={keyMenuOpen}
		menuAnchor={keyTriggerRef}
		isCustom={keyProvider?.id === CUSTOM_PROVIDER.id}
		onCustomSaved={() => { setKeyProvider(null); notifySettingsSaved("keys"); }}
		onToggleMenu={() => setKeyMenuOpen((v) => !v)}
		onPick={(p) => { setKeyProvider(p); setKeyMenuOpen(false); setKeyError(null); }}
		onValue={setKeyValue}
		onSave={() => void saveKey()}
	/>;

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
			data-testid="setup-backdrop"
			{...backdropDismiss}
		>
			<div
				role="dialog"
				aria-modal="true"
				data-lh-modal
				aria-label="Set up your models"
				data-testid="setup-dialog"
				className="settings-dialog-pop flex max-h-[85vh] w-[640px] max-w-[min(90vw,calc(100vw-2*max(env(safe-area-inset-left,0px),env(safe-area-inset-right,0px))))] flex-col overflow-hidden rounded-md border border-border bg-card shadow-xl"
				onClick={(e) => e.stopPropagation()}
			>
				<header className="flex h-15 shrink-0 items-center gap-3 border-b border-border px-5">
					<h2 className="font-title text-2xl tracking-tight">Set up your models</h2>
					<Hint label="Close" binding="escape" side="left">
<button
						type="button"
						aria-label="Close setup"
						data-testid="setup-close"
						autoFocus
						onClick={onClose}
						className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
					>
						✕
					</button>
</Hint>
				</header>

				{failed && (
					<p role="alert" data-testid="setup-catalog-error" className="px-6 py-3 text-sm text-foreground">
						Model catalog could not be loaded. Check the connection and retry. <button type="button" data-testid="setup-retry" className="underline" onClick={refresh}>Retry</button>
					</p>
				)}
				{stage === "loading" ? (
					!failed && <p data-testid="setup-stage-loading" role="status" className="px-6 py-5 text-xs text-muted-foreground">Loading models…</p>
				) : stage === "keys" ? (
					<div className="flex flex-col px-6 py-5">{keysBody}</div>
				) : (
					<div className="flex flex-col gap-4 overflow-y-auto px-6 py-5" data-testid="setup-stage-pickers">
						<p className="text-xs text-muted-foreground">
							Pick the model for each tier. All three are required before chats can start.
						</p>
						{SLOT_ORDER.map((slot) => {
							const entry = picked[slot];
							const level = levels[slot];
							const metadata = catalog?.models.find((m) => m.id === entry?.id && m.provider === entry.provider);
							// Unavailable metadata cannot erase or clamp a saved preference.
							const levelsForEntry = metadata?.supportedLevels ?? (entry ? Object.keys(THINKING_LABEL) : []);
							const available = catalog?.models ?? (failed ? [] : undefined);
							const slotCatalog = slot === "vision"
								? available?.filter((m) => m.input.includes("image") || m.provider === CUSTOM_PROVIDER.id)
								: available;
							return (
								<div key={slot} data-testid={`setup-slot-${slot}`} className="flex flex-col gap-1.5">
									<span className="flex items-center gap-1.5">
										<span className="font-ui text-sm text-foreground">{SLOT_META[slot].label}</span>
										{!runnable(slot) && (
											<span
												data-testid={`setup-needed-${slot}`}
												className="rounded-sm border border-border px-1 py-0.5 text-[10px] font-normal tracking-wide text-muted-foreground"
											>
												needed
											</span>
										)}
									</span>
									<span className="text-xs text-muted-foreground/70">{SLOT_META[slot].roster}</span>
									{slot !== "strong" && <><ChatGPTBackgroundAccess provider={entry?.provider} /><NativeSubscriptionBackgroundAccess provider={entry?.provider} /></>}
									<div className="flex items-center gap-2">
										<div className="relative flex-1">
											<Hint label={entry ? `${entry.provider}:${entry.id}` : "Pick a model…"}>
											<button
												type="button"
												aria-label={`${SLOT_META[slot].label} model`}
												data-testid={`setup-trigger-${slot}`}
												aria-expanded={openMenu?.slot === slot && openMenu.kind === "model"}
												onClick={() => setOpenMenu(openMenu?.slot === slot && openMenu.kind === "model" ? null : { slot, kind: "model" })}
												className="flex h-7 min-w-40 w-full items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
											>
												<span className="min-w-0 flex-1 truncate">{entry ? prettyModel(entry.id) : "Pick a model…"}</span>
												<span aria-hidden className="text-muted-foreground">
													▾
												</span>
											</button>
											</Hint>
											{/* Anchor by TESTID, not a ref (the settings-section pattern):
											    React attaches a host element's ref AFTER its descendants'
											    layout effects run, so a ref freshly attached in this same
											    commit (menu opening = the ref condition turning true) is
											    still null when MenuShell measures — place() gives up, the
											    menu stays invisible, and only a window resize (which re-runs
											    place()) shows it. querySelector at place time has no such
											    ordering hazard. Live-caught by the owner 2026-10-09: every
											    setup picker opened dead until a window resize. */}
											{openMenu?.slot === slot && openMenu.kind === "model" && (
												<MenuShell
													anchorTestid={`setup-trigger-${slot}`}
													testid={`setup-menu-${slot}`}
													preferredSide="down"
													align="left"
													menuClass="flex w-[22rem] flex-col rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
												>
													<ModelMenuList
														models={slotCatalog}
														effectiveId={entry?.id}
														effectiveProvider={entry?.provider}
														vision={slot === "vision"}
														minContext={COMPACTION_THRESHOLD_FLOOR}
														onPick={(m) => {
															editedSlots.current.add(slot);
															setPicked((prev) => ({ ...prev, [slot]: m }));
															// Auto-populate (chunk 2, owner: "populate
															// everywhere"): no explicit level → the
															// ordering's level for the fresh pick; an
															// explicit one rides (Save clamps server-side).
															setLevels((prev) => ({
																...prev,
																[slot]: populateLevel(prev[slot], m.supportedLevels),
															}));
															setOpenMenu(null);
														}}
														footer={slotCatalog && slotCatalog.length === 0 && slot === "vision" ? "No image-capable models. Add a provider key with access to a vision model." : undefined}
													/>
												</MenuShell>
											)}
										</div>
										{/* Thinking selector (chunk 2): editable, pre-populated from
										    the ordering per picked model — no model, no levels. */}
										<div className="relative">
											<button
												type="button"
												aria-label={`${SLOT_META[slot].label} thinking`}
												data-testid={`setup-thinking-${slot}`}
												aria-expanded={openMenu?.slot === slot && openMenu.kind === "thinking"}
												disabled={!entry}
												onClick={() => setOpenMenu(openMenu?.slot === slot && openMenu.kind === "thinking" ? null : { slot, kind: "thinking" })}
												className="flex h-7 w-24 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40"
											>
												<span className="min-w-0 flex-1 truncate text-left">
													{entry ? (level ? THINKING_LABEL[level] ?? level : "…") : "—"}
												</span>
												<span aria-hidden className="text-muted-foreground">
													▾
												</span>
											</button>
											{openMenu?.slot === slot && openMenu.kind === "thinking" && (
												<MenuShell
													anchorTestid={`setup-thinking-${slot}`}
													testid={`setup-thinking-menu-${slot}`}
													preferredSide="down"
													align="left"
													menuClass="flex w-44 flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
												>
													<ThinkingMenuList
														levels={levelsForEntry.map(String)}
														effectiveLevel={level}
														onPick={(lv) => {
															editedSlots.current.add(slot);
															setLevels((prev) => ({ ...prev, [slot]: lv as ThinkingLevel }));
															setOpenMenu(null);
														}}
													/>
												</MenuShell>
											)}
										</div>
									</div>
								</div>
							);
						})}
						<div className="flex items-center gap-3">
							<button
								type="button"
								data-testid="setup-save"
								disabled={!allPicked || saving}
								onClick={() => void save()}
								className="rounded-sm border border-border bg-background px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-40"
							>
								{saving ? "Saving…" : "Save models"}
							</button>
							{error && <p className="text-xs text-red-400">{error}</p>}
						</div>
					</div>
				)}
			</div>
		</div>,
		document.body,
	);
}
