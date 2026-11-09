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
	isDarkBackground,
	isReadableInk,
	isHexColor,
	resolveSettings,
	type AppearanceSettings,
	type GraphSettings,
} from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { useAppearance } from "./appearance.tsx";
import { FontMenuList } from "./model-menu";
import { bindSettingsMenuDismiss, CommitInput, SettingsMenuTrigger, SettingsRow, ThinSelect, Toggle } from "./controls.tsx";

/** The factory reading family — the DEFAULT row's identity (unset =
 *  this). Exported for tests. */
export const DEFAULT_READING_FONT = "Source Sans 3";

const HEX_HINT = "Use a hex color like #1a2b3c.";
const INK_HINT = "Pick a lighter color: this one is hard to read on the background.";

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

export function AppearanceSection({
	appearance,
	onSectionChange,
}: {
	/** The record's appearance delta (absent = factory). */
	appearance: AppearanceSettings | undefined;
	/** PUT the whole appearance section; the page re-applies on success. */
	onSectionChange: (next: AppearanceSettings) => void;
}) {
	const { appearance: resolved } = useAppearance();
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
							const families = [...new Set(fonts.map((f) => f.family))]
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

	// Any click outside the open menu, or Esc, closes it (bindSettingsMenuDismiss).
	useEffect(() => {
		if (!fontMenuOpen) return;
		return bindSettingsMenuDismiss(menuAnchorRef, () => setFontMenuOpen(false));
	}, [fontMenuOpen]);

	return (
		<>
			<SettingsRow label="Mode" hint="Coming soon" testid="row-mode" dimmed>
				<ThinSelect value="dark" ariaLabel="mode" onChange={() => {}} testid="select-mode" disabled>
					<option value="dark">Dark</option>
				</ThinSelect>
			</SettingsRow>
			<SettingsRow
				label="Background"
				hint="Empty = #141414"
				testid="row-background"
			>
				<CommitInput
					value={appearance?.background ?? ""}
					placeholder="#141414"
					ariaLabel="background hex"
					testid="input-background"
					onCommit={(v) => {
						if (v !== "" && !isHexColor(v)) return HEX_HINT;
						// The theme is dark-only: a light background would hide the text.
						if (v !== "" && !isDarkBackground(v)) return "Pick a darker color: the text is light.";
						if ([md?.boldColor, md?.italicColor].some((ink) => ink && !isReadableInk(ink, v || null))) return "Pick another color: your bold or italic color would be hard to read on it.";
						onSectionChange({ ...appearance, background: v === "" ? null : v });
					}}
				/>
			</SettingsRow>
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
							onSectionChange({ ...appearance, proseFontSize: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return; // bad input: no write, factory stays
						onSectionChange({ ...appearance, proseFontSize: Math.min(24, Math.max(12, Math.round(n))) });
					}}
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
							onSectionChange({ ...appearance, mdRendering: { ...md, headingWeight: undefined } });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return;
						onSectionChange({
							...appearance,
							mdRendering: { ...md, headingWeight: Math.min(900, Math.max(100, Math.round(n))) },
						});
					}}
				/>
			</SettingsRow>
			{/* The emphasis inks default to the REGULAR TEXT COLOR — the
			    empty-state labels say so; explicit hex overrides ride unchanged. */}
			<SettingsRow label="Bold color" hint="Empty = same as text" testid="row-bold-color">
				<CommitInput
					value={md?.boldColor ?? ""}
					placeholder="same as text"
					ariaLabel="bold color"
					testid="input-bold-color"
					onCommit={(v) => {
						if (v !== "" && !isHexColor(v)) return HEX_HINT;
						if (v !== "" && !isReadableInk(v, appearance?.background ?? null)) return INK_HINT;
						onSectionChange({ ...appearance, mdRendering: { ...md, boldColor: v === "" ? null : v } });
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Italic color" hint="Empty = same as text" testid="row-italic-color">
				<CommitInput
					value={md?.italicColor ?? ""}
					placeholder="same as text"
					ariaLabel="italic color"
					testid="input-italic-color"
					onCommit={(v) => {
						if (v !== "" && !isHexColor(v)) return HEX_HINT;
						if (v !== "" && !isReadableInk(v, appearance?.background ?? null)) return INK_HINT;
						onSectionChange({ ...appearance, mdRendering: { ...md, italicColor: v === "" ? null : v } });
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
	onSectionChange: (next: GraphSettings) => void;
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
							onSectionChange({ ...graph, extractionChunkTokens: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n) || n <= 0) return "Enter a number of tokens, or leave it empty for the default.";
						// Mirror the server's floor (cost protection) and ceiling.
						onSectionChange({
							...graph,
							extractionChunkTokens: Math.min(EXTRACTION_CHUNK_TOKENS_MAX, Math.max(EXTRACTION_CHUNK_TOKENS_FLOOR, Math.round(n))),
						});
					}}
				/>
			</SettingsRow>
		</>
	);
}