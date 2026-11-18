"use client";
/**
 * The Appearance + Graph sections.
 *
 * Appearance controls resolve against the factory in the provider; writes
 * PUT the whole appearance section and hand the delta back so the CSS
 * variables move IMMEDIATELY (the section's whole point — it must DO
 * something). Hex inputs commit on blur/Enter; the background derives the
 * raised/accent/edge palette in code (components/settings/appearance.tsx).
 * Mode is dark-only for now: the control renders DISABLED with a note — a
 * lying control is worse than an honest disabled one.
 *
 * Reading font: a searchable dropdown of the user's INSTALLED fonts
 * (FontMenuList over model-menu's machine) fed by window.queryLocalFonts()
 * in the desktop shell — the
 * enumeration is click-bound (the API requires user activation), deduped
 * to unique families, the factory family excluded (the DEFAULT row is
 * it). In a plain dev browser the API is absent → a small curated list
 * + a footer that says exactly that — never a fabricated system list.
 * A query matching no family offers a "Use '<query>'" row, the manual
 * escape path. Empty/unset keeps meaning Source Sans 3.
 *
 * Emphasis inks: the factory tokens default to the regular text color
 * (globals.css); the rows' empty-state labels say "same as text".
 */

import { useEffect, useRef, useState } from "react";
import {
	EXTRACTION_CHUNK_TOKENS_FLOOR,
	EXTRACTION_CHUNK_TOKENS_MAX,
	isHexColor,
	resolveSettings,
	THEME_COLOR_KEYS,
	type AppearanceSettings,
	type GraphSettings,
	type ThemeColorKey,
} from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { useInteractionLayers } from "@/components/interaction-layers";
import { Hint } from "@/components/ui/hint";
import { BUNDLED_READING_FONTS, useAppearance } from "./appearance.tsx";
import { FontMenuList } from "./model-menu";
import { ThemeCards } from "./theme-cards.tsx";
import { CommitInput, returnSettingsMenuFocus, SettingsMenuTrigger, SettingsRow, Toggle } from "./controls.tsx";

/** The factory reading family — the DEFAULT row's identity (unset =
 *  this). Exported for tests. */
export const DEFAULT_READING_FONT = "Source Sans 3";

const HEX_HINT = "Use a hex color like #1a2b3c.";

/** The dev-browser fallback list (queryLocalFonts is absent there):
 *  the app's own knowns plus a handful of ubiquitous macOS families,
 *  honestly LABELED as common — never presented as the system's real
 *  list. The factory family is absent: the DEFAULT row is it. Exported
 *  for tests. */
export const CURATED_FALLBACK_FONTS: readonly string[] = [
	"Arial",
	"CMU Serif",
	"Courier New",
	"Georgia",
	"Helvetica",
	"Helvetica Neue",
	"JetBrains Mono",
	"Menlo",
	"Times New Roman",
	"Trebuchet MS",
	"Verdana",
];

/** window.queryLocalFonts' shape as this section consumes it (family is
 *  the only field used; the API returns one FontData per FACE — the
 *  caller dedupes). */
type LocalFontsApi = () => Promise<Array<{ family: string }>>;

/** The Local Font Access seam — read lazily (SSR has no window, and
 *  render-time access would evaluate the API on the server). */
function localFontsApi(): LocalFontsApi | null {
	if (typeof window === "undefined") return null;
	return (window as unknown as { queryLocalFonts?: LocalFontsApi }).queryLocalFonts ?? null;
}

/** Compose the reading-font pick: null (or blank) = the factory
 *  Source Sans 3; otherwise the family verbatim (trimmed — the
 *  sanitizer trims again server-side). Pure — exported for tests. */
export function composeFontFamily(
	appearance: AppearanceSettings | undefined,
	family: string | null,
): AppearanceSettings {
	const value = family?.trim() ?? "";
	return { ...appearance, fontFamily: value === "" ? null : value };
}

/** The Colors grid's labels and the one hint that explains a key. */
const COLOR_LABELS: Record<ThemeColorKey, { label: string; note?: string }> = {
	background: { label: "Background" },
	accent: { label: "Accent", note: "Focus rings, toggles, selection" },
	surface: { label: "Surface", note: "Cards, inputs, sidebar" },
	bold: { label: "Bold" },
	border: { label: "Border" },
	italic: { label: "Italic" },
	text: { label: "Text" },
	code: { label: "Inline code" },
	textMuted: { label: "Muted text" },
	error: { label: "Error" },
	success: { label: "Success" },
	warning: { label: "Warning" },
};

/** The legacy test ids of the three pre-theme rows (kept stable). */
const LEGACY_TESTIDS: Partial<Record<ThemeColorKey, string>> = {
	background: "input-background",
	bold: "input-bold-color",
	italic: "input-italic-color",
};

/** The stored override for one theme color ("" = none). Pure — exported
 *  for tests. */
export function colorOverride(appearance: AppearanceSettings | undefined, key: ThemeColorKey): string {
	if (key === "background") return appearance?.background ?? "";
	if (key === "bold") return appearance?.mdRendering?.boldColor ?? "";
	if (key === "italic") return appearance?.mdRendering?.italicColor ?? "";
	return appearance?.colors?.[key] ?? "";
}

/** Compose one override into the section ("" = back to the theme's).
 *  Every other field rides along untouched. Pure — exported for tests. */
export function composeColorOverride(
	appearance: AppearanceSettings | undefined,
	key: ThemeColorKey,
	value: string,
): AppearanceSettings {
	const v = value === "" ? null : value;
	if (key === "background") return { ...appearance, background: v };
	if (key === "bold") return { ...appearance, mdRendering: { ...appearance?.mdRendering, boldColor: v } };
	if (key === "italic") return { ...appearance, mdRendering: { ...appearance?.mdRendering, italicColor: v } };
	const colors = { ...appearance?.colors };
	if (v === null) delete colors[key];
	else colors[key] = v;
	return { ...appearance, colors };
}

/** "Reset all": every color back to the theme's; type knobs untouched. */
export function clearColorOverrides(appearance: AppearanceSettings | undefined): AppearanceSettings {
	const { background: _bg, colors: _colors, ...rest } = appearance ?? {};
	const md = appearance?.mdRendering;
	if (!md) return rest;
	const { boldColor: _b, italicColor: _i, ...mdRest } = md;
	return { ...rest, mdRendering: mdRest };
}

function ColorOverrideRow({
	colorKey,
	value,
	themeColor,
	effective,
	onCommit,
}: {
	colorKey: ThemeColorKey;
	value: string;
	themeColor: string;
	effective: string;
	onCommit: (next: string) => string | void | boolean | Promise<boolean>;
}) {
	const { label, note } = COLOR_LABELS[colorKey];
	const empty = `Empty = ${themeColor}`;
	return (
		<SettingsRow label={label} hint={note ? `${note} · ${empty}` : empty} testid={`row-color-${colorKey}`}>
			<span className="flex items-center gap-2">
				<span
					aria-hidden
					data-testid={`swatch-${colorKey}`}
					className="size-4 shrink-0 rounded-sm border border-border"
					style={{ background: effective }}
				/>
				<CommitInput
					value={value}
					placeholder={themeColor}
					ariaLabel={`${label.toLowerCase()} hex`}
					testid={LEGACY_TESTIDS[colorKey] ?? `input-color-${colorKey}`}
					onCommit={onCommit}
				/>
			</span>
		</SettingsRow>
	);
}

export function AppearanceSection({
	appearance,
	onSectionChange,
}: {
	/** The record's appearance delta (absent = factory). */
	appearance: AppearanceSettings | undefined;
	/** PUT the whole appearance section; the page re-applies on success. */
	onSectionChange: (next: AppearanceSettings) => void | boolean | Promise<boolean>;
}) {
	const { appearance: resolved, activeTheme, colors, themes, refreshThemes } = useAppearance();
	const md = appearance?.mdRendering;

	// The font dropdown's open state + its enumeration cache. undefined =
	// not enumerated yet (desktop: click-bound queryLocalFonts pending);
	// null = enumeration UNAVAILABLE (the API is absent in a plain
	// browser, rejected, or resolved EMPTY — an Electron grant can pass and
	// still yield zero fonts) → the curated fallback; a list = the deduped
	// families. enumEmpty distinguishes WHY it fell back, for the footer.
	const [fontMenuOpen, setFontMenuOpen] = useState(false);
	const [localFonts, setLocalFonts] = useState<string[] | null | undefined>(undefined);
	const [enumEmpty, setEnumEmpty] = useState(false);
	const menuAnchorRef = useRef<HTMLSpanElement>(null);
	const interactions = useInteractionLayers();

	// The enumeration runs INSIDE the trigger click — queryLocalFonts
	// requires user activation, so it cannot be a mount effect. First
	// open only: the families are cached for the section's life (font
	// installs mid-dialog are not a case); ANY unavailable enumeration
	// (absent / rejected / empty) falls back to the curated list rather
	// than an empty picker.
	const openFontMenu = () => {
		setFontMenuOpen((open) => {
			if (!open && localFonts === undefined) {
				const api = localFontsApi();
				if (api === null) {
					setLocalFonts(null);
					setEnumEmpty(false);
				} else {
					void api()
						.then((fonts) => {
							const installed = fonts.map((f) => f.family);
							// The bundled families join the installed ones (they
							// render whether or not the OS has them), but only
							// when the OS list was actually read.
							const families = [...new Set(installed.length ? [...installed, ...Object.keys(BUNDLED_READING_FONTS)] : [])]
								.filter((f) => f !== DEFAULT_READING_FONT)
								.sort((a, b) => a.localeCompare(b));
							if (families.length === 0) {
								// Resolved-but-empty: not a failure the catch sees,
								// but still unavailable.
								setLocalFonts(null);
								setEnumEmpty(true);
							} else {
								setLocalFonts(families);
							}
						})
						.catch(() => {
							setLocalFonts(null);
							setEnumEmpty(false);
						});
				}
			}
			return !open;
		});
	};

	const pickFont = (family: string | null) => {
		setFontMenuOpen(false);
		onSectionChange(composeFontFamily(appearance, family));
	};

	// Any click outside the open menu closes it; Esc is the menu layer's.
	useEffect(() => {
		if (!fontMenuOpen) return;
		const onPointerDown = (e: PointerEvent) => {
			if (!interactions.isElementEligible(document.querySelector<HTMLElement>('[data-testid="font-menu"]'))) return;
			const target = e.target as Node;
			if (menuAnchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) {
				setFontMenuOpen(false);
			}
			// else: outside the dialog — the dialog's own close handles it.
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [fontMenuOpen, interactions]);
	// A closed font menu (pick or Esc) hands focus back to its trigger.
	useEffect(() => {
		if (!fontMenuOpen) return;
		return returnSettingsMenuFocus(menuAnchorRef);
	}, [fontMenuOpen]);

	return (
		<>
			<ThemeCards
				themes={themes}
				active={activeTheme}
				appearance={appearance}
				onSelect={(id) => onSectionChange({ ...appearance, theme: id })}
				onImported={() => void refreshThemes()}
				onRemoved={(removed) => {
					void refreshThemes();
					// The server already fell back to Default; the write keeps the
					// dialog's record mirror and the live vars in step with it.
					if (removed.id === activeTheme.id) onSectionChange({ ...appearance, theme: "default" });
				}}
			/>
			<div data-testid="group-colors" className="mt-5 flex flex-col gap-2">
				<div className="flex items-end justify-between gap-4">
					<p className="text-xs uppercase tracking-widest text-muted-foreground">
						Colors{" "}
						<span className="normal-case tracking-normal text-muted-foreground/70">
							· overrides on top of the theme, kept when you switch
						</span>
					</p>
					<button
						type="button"
						data-testid="colors-reset"
						onClick={() => onSectionChange(clearColorOverrides(appearance))}
						className="h-6 shrink-0 rounded-sm px-2 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						Reset all
					</button>
				</div>
				<div className="grid grid-cols-2 gap-x-10 gap-y-2">
					{THEME_COLOR_KEYS.map((key) => (
						<ColorOverrideRow
							key={key}
							colorKey={key}
							value={colorOverride(appearance, key)}
							themeColor={activeTheme.colors[key]}
							effective={colors[key]}
							onCommit={(v) => (v !== "" && !isHexColor(v) ? HEX_HINT : onSectionChange(composeColorOverride(appearance, key, v)))}
						/>
					))}
				</div>
			</div>
			<p className="mt-5 mb-2 text-xs uppercase tracking-widest text-muted-foreground">Typography</p>
			<SettingsRow
				label="Reading font"
				hint={`Empty = ${DEFAULT_READING_FONT}`}
				testid="row-font"
			>
				<span ref={fontMenuOpen ? menuAnchorRef : undefined} className="relative flex items-center gap-2">
					{/* The shared Agent/Appearance collapsed-menu trigger. The
					    tooltip rides the CLOSED button ONLY — never while the
					    dropdown is out, where it would pop over the open menu.
					    It stays wrapped either way, so closing keeps its focus. */}
					<Hint label="Choose from your installed fonts" side="left" disabled={fontMenuOpen}>
						<SettingsMenuTrigger
							value={appearance?.fontFamily || DEFAULT_READING_FONT}
							aria-label="Reading font"
							aria-expanded={fontMenuOpen}
							data-testid="font-trigger"
							onClick={openFontMenu}
							className="min-w-20"
						/>
					</Hint>
					{fontMenuOpen && (
						<MenuShell
							preferredSide="down"
							anchorTestid="font-trigger"
							testid="font-menu"
							onClose={() => { setFontMenuOpen(false); return "closed"; }}
							menuClass="flex w-[18rem] flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
						>
							<FontMenuList
								families={localFonts === undefined ? undefined : (localFonts ?? [...CURATED_FALLBACK_FONTS])}
								effectiveFamily={appearance?.fontFamily ?? null}
								onPick={pickFont}
								footer={
									localFonts === undefined
										? undefined
										: localFonts === null
											? enumEmpty
												? "Common families — installed fonts could not be read"
												: "Common families — your installed list needs the desktop app"
											: "Your installed fonts"
								}
							/>
						</MenuShell>
					)}
				</span>
			</SettingsRow>
			<SettingsRow label="Reading font size" hint={`${resolved.proseFontSize}px`} testid="row-prose-size">
				<CommitInput
					type="number"
					value={String(appearance?.proseFontSize ?? "")}
					placeholder="16"
					ariaLabel="prose font size"
					testid="input-prose-size"
					onCommit={(v) => {
						// Empty = factory default: omit the key so the record UNSETS and
						// the field stays empty (absence, not null, is the unset for
						// numbers). Number("") is 0, so clamping would write 12.
						if (v === "") {
							return onSectionChange({ ...appearance, proseFontSize: undefined });
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return false; // bad input: no write, factory stays
						return onSectionChange({ ...appearance, proseFontSize: Math.min(24, Math.max(12, Math.round(n))) });
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Code ligatures" testid="row-code-ligatures">
				<Toggle
					checked={resolved.codeLigatures}
					label="Code ligatures"
					onChange={(on) => onSectionChange({ ...appearance, codeLigatures: on })}
				/>
			</SettingsRow>
			<SettingsRow label="Chat names in serif" testid="row-session-serif">
				<Toggle
					checked={appearance?.sessionNameSerif ?? true}
					label="chat names serif"
					onChange={(on) => onSectionChange({ ...appearance, sessionNameSerif: on })}
				/>
			</SettingsRow>
			<SettingsRow label="Heading weight" hint={`${resolved.mdRendering.headingWeight}`} testid="row-heading-weight">
				<CommitInput
					type="number"
					value={String(md?.headingWeight ?? "")}
					placeholder="900"
					ariaLabel="heading weight"
					testid="input-heading-weight"
					onCommit={(v) => {
						// Empty = factory default: absence is the unset representation
						// (Number("") is 0, so clamping would write 100).
						if (v === "") {
							return onSectionChange({ ...appearance, mdRendering: { ...md, headingWeight: undefined } });
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return false;
						return onSectionChange({
							...appearance,
							mdRendering: { ...md, headingWeight: Math.min(900, Math.max(100, Math.round(n))) },
						});
					}}
				/>
			</SettingsRow>
		</>
	);
}

export function GraphSection({
	graph,
	onSectionChange,
}: {
	graph: GraphSettings | undefined;
	onSectionChange: (next: GraphSettings) => void | boolean | Promise<boolean>;
}) {
	// Three controls: the extraction master switch, the display-only
	// rendering switch, and the chunk budget (it denominates the coverage
	// ring AND gates the auto-extraction trigger: turn settle ≥ budget fires
	// the run).
	//
	// Resolved through the SAME core resolver the server's effective
	// settings use, so the hint and placeholder report exactly the number
	// the trigger waits for — never a second hand-rolled default.
	const resolved = resolveSettings(graph === undefined ? null : { version: 1, graph }).graph;
	return (
		<>
			{/* EXTRACTION: the DATA channel — the pipeline, the auditor, the
			    prober's graph tools. Off ≠ no graph; off = the graph stops
			    growing. The testid keeps the stored key's name (enabled). */}
			<SettingsRow label="Extraction" hint="Off = the graph stops growing" testid="graph-row-enabled">
				<Toggle
					checked={graph?.enabled ?? true}
					label="extraction enabled"
					onChange={(on) =>
						// Compose: the section PUT is replace-whole, so the row must
						// not drop its sibling fields (a stored budget).
						onSectionChange({ ...graph, enabled: on })
					}
				/>
			</SettingsRow>
			{/* GRAPH RENDERING: display-only. Off = the home shows the chains view
			    instead of the canvas. The ledgers, the pipeline, everything
			    data keeps working — that is the extraction switch above. */}
			<SettingsRow label="Graph rendering" hint="Off = home shows the chains view" testid="graph-row-rendering">
				<Toggle
					checked={graph?.rendering ?? true}
					label="graph rendering enabled"
					onChange={(on) => onSectionChange({ ...graph, rendering: on })}
				/>
			</SettingsRow>
			<SettingsRow
				label="Extraction chunk budget"
				hint={`${resolved.extractionChunkTokens} tok`}
				testid="graph-row-chunk-tokens"
			>
				<CommitInput
					type="number"
					value={String(graph?.extractionChunkTokens ?? "")}
					placeholder={String(resolved.extractionChunkTokens)}
					ariaLabel="extraction chunk budget"
					testid="input-chunk-tokens"
					onCommit={(v) => {
						// Empty = factory default: absence is the unset for numbers —
						// Number("") is 0, so clamping would write the floor instead.
						if (v === "") {
							return onSectionChange({ ...graph, extractionChunkTokens: undefined });
						}
						const n = Number(v);
						if (!Number.isFinite(n) || n <= 0) return "Enter a number of tokens, or leave it empty for the default.";
						// Mirror the server's floor (cost protection) and ceiling.
						return onSectionChange({
							...graph,
							extractionChunkTokens: Math.min(EXTRACTION_CHUNK_TOKENS_MAX, Math.max(EXTRACTION_CHUNK_TOKENS_FLOOR, Math.round(n))),
						});
					}}
				/>
			</SettingsRow>
		</>
	);
}