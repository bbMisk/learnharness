"use client";
/**
 * Thin settings primitives: the control kit the settings dialog needs.
 * Sections → groups → rows; everything SSRs clean (render tests pin the
 * sections' markup).
 *
 * Dependency graying: the WHOLE row dims (opacity-40, label and control
 * together) and the control itself locks — the row owns the dim.
 */

import { useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { isComposing } from "@/components/ime";
import { focusLost } from "@/components/focus-return";

/** Fork: bound while a Settings menu is open; the returned cleanup hands
 *  focus back to the menu's trigger when the close (a pick, or Esc via the
 *  menu's interaction layer) took the focused search box with it. Focus
 *  that already moved somewhere real (a newly opened field) is left alone. */
export function returnSettingsMenuFocus(anchorRef: RefObject<Element | null>): () => void {
	const trigger = anchorRef.current?.querySelector<HTMLElement>('[aria-expanded="true"]') ?? anchorRef.current?.querySelector<HTMLElement>("button");
	return () => { if (trigger?.isConnected && focusLost()) trigger.focus(); };
}

/** The settings dropdown dismissal, bound while a menu is open; returns
 *  the cleanup. A pointerdown inside the anchor or a portaled menu
 *  ([data-lh-menu]) is ignored; one elsewhere inside the dialog closes the
 *  menu; one outside the dialog is left to the dialog's own close. Esc
 *  closes the menu and stops propagating to window listeners; the dialog
 *  stays open because its own Esc skips while a MenuShell is open. Focus
 *  goes back to the menu's trigger, not to the body, after Esc or a pick. */
export function bindSettingsMenuDismiss(anchorRef: RefObject<Element | null>, close: () => void): () => void {
	const trigger = anchorRef.current?.querySelector<HTMLElement>('[aria-expanded="true"]') ?? anchorRef.current?.querySelector<HTMLElement>("button");
	const onPointerDown = (e: PointerEvent) => {
		const target = e.target as Node;
		if (anchorRef.current?.contains(target)) return;
		if (target instanceof Element && target.closest("[data-lh-menu]")) return;
		if (target instanceof Element && target.closest('[role="dialog"]')) close();
	};
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape" && !e.defaultPrevented && !isComposing(e)) {
			e.preventDefault();
			e.stopPropagation();
			close();
			trigger?.focus();
		}
	};
	document.addEventListener("pointerdown", onPointerDown);
	document.addEventListener("keydown", onKeyDown);
	return () => {
		document.removeEventListener("pointerdown", onPointerDown);
		document.removeEventListener("keydown", onKeyDown);
		// A pick closed the menu and took its focused search box with it.
		if (trigger?.isConnected && focusLost()) trigger.focus();
	};
}

/** A section block: pronounced mono heading + content. */
export function SettingsSection({
	title,
	hint,
	children,
	testid,
}: {
	title: string;
	/** One quiet line under the header — only where it earns its place. */
	hint?: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<section data-testid={testid} className="px-4 py-5 sm:px-6">
			<h2 className="text-sm uppercase tracking-widest text-foreground">{title}</h2>
			{hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
			<div className="mt-4 flex flex-col gap-3">{children}</div>
		</section>
	);
}

/** A labeled sub-group inside a section (owner, 2026-09-20: clear
 *  separation — Models / Tools / Prompts read as three blocks). */
export function SettingsGroup({
	label,
	children,
	testid,
}: {
	label: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<div data-testid={testid} className="mt-5 border-t border-border/60 pt-4 first:mt-0 first:border-t-0 first:pt-0">
			<p className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">{label}</p>
			<div className="flex flex-col gap-2">{children}</div>
		</div>
	);
}

/** One label + one control. Label left (with optional muted hint), control
 *  right — the settings row shape. */
export function SettingsRow({
	label,
	hint,
	children,
	testid,
	dimmed,
}: {
	label: string;
	hint?: ReactNode;
	children: React.ReactNode;
	testid?: string;
	/** Dependency graying, graph-view style: the whole row dims when the
	 *  control is inert (parent off, no file yet, …). */
	dimmed?: boolean;
}) {
	return (
		<div data-testid={testid} className={cn("flex items-center justify-between gap-4 py-1", dimmed && "opacity-40")}>
			<span className="min-w-0">
				<span className="block font-prose text-(length:--lh-prose-size)">{label}</span>
				{hint && <span className="block text-xs text-muted-foreground/70">{hint}</span>}
			</span>
			{children}
		</div>
	);
}

/** The existing Agent/Appearance collapsed-menu look, shared with dictation.
 * `unavailable` preserves callers that gate clicks without native disabling;
 * `disabled` retains native button semantics where the caller requires them. */
export function SettingsMenuTrigger({
	value, unavailable, disabled, className, ...props
}: Omit<ComponentPropsWithRef<"button">, "value" | "children"> & {
	value: string;
	unavailable?: boolean;
}) {
	return <button
		type="button"
		{...props}
		disabled={disabled}
		className={cn(
			"flex h-7 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors",
			disabled || unavailable ? "cursor-not-allowed" : "hover:border-muted-foreground/50",
			className,
		)}
	>
		<span className="min-w-0 flex-1 truncate">{value}</span>
		<span aria-hidden className="text-muted-foreground">▾</span>
	</button>;
}

export function SettingsSegmentedControl<T extends string>({ label, options, value, disabled, testidPrefix, onChange }: {
	label: string;
	options: readonly { value: T; label: string }[];
	value: T;
	disabled?: boolean;
	testidPrefix?: string;
	onChange: (value: T) => void;
}) {
	return <div role="radiogroup" aria-label={label} className="flex rounded-lg border border-border/60 bg-muted/30 p-0.5">
		{options.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.value === value}
			data-testid={testidPrefix ? `${testidPrefix}-${option.value}` : undefined}
			disabled={disabled} onClick={() => onChange(option.value)}
			className={cn("h-8 rounded-md px-3 text-sm font-medium transition-colors",
				option.value === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
			{option.label}
		</button>)}
	</div>;
}

/** The on/off switch — a plain button in the switch role. */
export function Toggle({
	checked,
	disabled,
	onChange,
	label,
	discIcon,
	title,
}: {
	checked: boolean;
	disabled?: boolean;
	onChange: (next: boolean) => void;
	/** Accessible name for the switch role. */
	label: string;
	/** Optional icon disc (owner round, 2026-10-07): the figure cards' invert
	 *  toggle renders the half-filled contrast circle AS the disc — the icon
	 *  carries the meaning; plain toggles keep the plain disc. */
	discIcon?: ReactNode;
	/** Optional native tooltip on the switch. */
	title?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			{...(title ? { title } : {})}
			disabled={disabled}
			data-testid={`toggle-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative h-4.5 w-8 shrink-0 rounded-full border border-border transition-colors",
				// Owner (2026-09-20): on is a gray track with a WHITE disc (a full-white
				// track was too loud); off stays the muted track. Theme wave: the on
				// track is the theme accent (Default's accent IS that gray).
				checked ? "bg-(--lh-accent)" : "bg-muted",
				disabled && "cursor-not-allowed",
			)}
		>
			{discIcon ? (
				// The icon IS the disc: same size, same slide, same state colors —
				// only the knob's face changes (the invert affordance).
				<span
					className={cn(
						"absolute left-0 top-0.5 flex size-3 items-center justify-center rounded-full transition-transform",
						checked ? "translate-x-4 text-foreground" : "translate-x-0.5 text-muted-foreground",
					)}
				>
					{discIcon}
				</span>
			) : (
				<span
					className={cn(
						"absolute left-0 top-0.5 size-3 rounded-full transition-transform",
						// 2px inset from each inner edge, both states (owner round: the on
						// disc used to touch the pill's right edge).
						checked ? "translate-x-4 bg-foreground" : "translate-x-0.5 bg-muted-foreground",
					)}
				/>
			)}
		</button>
	);
}

/** A thin select — native element, options as given, dressed like the
 *  custom ▾ menu triggers (SettingsMenuTrigger): no native arrow, an inline ▾. */
export function ThinSelect({
	value,
	onChange,
	children,
	ariaLabel,
	testid,
	disabled,
	className,
}: {
	value: string;
	onChange: (next: string) => void;
	children: React.ReactNode;
	ariaLabel: string;
	testid?: string;
	disabled?: boolean;
	/** Sizing for the wrapper (e.g. "w-full min-w-0"). */
	className?: string;
}) {
	return (
		<span className={cn("relative inline-flex", className)}>
			<select
				value={value}
				aria-label={ariaLabel}
				data-testid={testid}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value)}
				className={cn(
					"h-7 w-full min-w-0 appearance-none rounded-sm border border-border bg-background pl-1.5 pr-5 font-ui text-xs text-foreground outline-none transition-colors",
					disabled ? "cursor-not-allowed" : "hover:border-muted-foreground/50",
				)}
			>
				{children}
			</select>
			<span aria-hidden className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 font-ui text-xs text-muted-foreground">▾</span>
		</span>
	);
}

/** Shared graph/settings range control; the label and value stay paired. */
export function SettingsSlider({ label, min, max, step, value, display, onChange, disabled, showLabel = true }: {
	label: string;
	min?: number;
	max?: number;
	step?: number;
	value: number;
	display?: string;
	/** SettingsRow supplies the visible label when false. */
	showLabel?: boolean;
	onChange: (value: number) => void;
	disabled?: boolean;
}) {
	return <label className={`flex flex-col gap-1${disabled ? " opacity-40" : ""}`}>
		<span className="flex items-center justify-between text-[11px] text-muted-foreground">
			{showLabel && label}<span className="tabular-nums">{display ?? value}</span>
		</span>
		<input type="range" aria-label={label} min={min} max={max} step={step} value={value} disabled={disabled}
			onChange={(e) => onChange(Number(e.target.value))} className="h-1.5 w-full accent-primary" />
	</label>;
}

/** Internal acknowledgement: false retains a rejected/unsaved draft. */
export type SettingsCommitResult = boolean | Promise<boolean>;

/** A thin hex/text input committing on blur + Enter (settings pace, not
 *  typing pace — every commit is a section PUT). */
export function CommitInput({
	value,
	placeholder,
	onCommit,
	ariaLabel,
	testid,
	type = "text",
	disabled,
	min,
	max,
	step,
}: {
	/** "" = unset (the factory default). Mirrors the STORED record —
	 *  after a clamped/normalized commit this flows back and the field
	 *  snaps to the stored truth (owner repro: a negative size kept
	 *  displaying "-5" while 12 was stored). */
	value: string;
	placeholder?: string;
	/** Refusal: a message (shown under the field until the next commit)
	 *  or false (silent). Anything else, sync or async, acknowledges. */
	onCommit: (next: string) => string | void | SettingsCommitResult | Promise<string | void | boolean>;
	ariaLabel: string;
	testid?: string;
	type?: "text" | "number";
	disabled?: boolean;
	min?: number;
	max?: number;
	step?: number;
}) {
	// Keep the native editing buffer: number inputs can display an incomplete
	// token while exposing value="" and badInput=true. Writing a controlled
	// value back on blur/render would erase text we cannot reconstruct.
	const [initialValue] = useState(value);
	const [, renderAcknowledgement] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const dirty = useRef(false);
	const revision = useRef(0);
	const latestCommit = useRef(0);
	const pending = useRef(new Set<number>());
	useLayoutEffect(() => {
		if (!dirty.current && inputRef.current && inputRef.current.value !== value) {
			inputRef.current.value = value;
		}
	});
	const revert = (element: HTMLInputElement) => {
		dirty.current = false;
		element.value = value;
	};

	const commit = async (element: HTMLInputElement) => {
		if (disabled) return;
		// Letters in a number field read as "" — refuse them instead of
		// committing a clear, and show the stored value again.
		if (type === "number" && element.validity?.badInput) {
			revert(element);
			setError("Enter a number.");
			return;
		}
		if (!dirty.current) return;
		const version = revision.current;
		if (pending.current.has(version)) return;
		const next = element.value.trim();
		if (next === value && pending.current.size === 0) {
			dirty.current = false;
			setError(null);
			renderAcknowledgement((n) => n + 1);
			return;
		}
		const ticket = ++latestCommit.current;
		pending.current.add(version);
		try {
			const result = await onCommit(next);
			if (inputRef.current !== element || revision.current !== version || latestCommit.current !== ticket) return;
			if (result === false) return; // a silent refusal keeps the text
			// Accepted, or refused with a message: the field shows the record again.
			dirty.current = false;
			setError(typeof result === "string" ? result : null);
			renderAcknowledgement((n) => n + 1);
		} catch {
			// Domain adapters own error presentation; a rejected save keeps text.
		} finally {
			pending.current.delete(version);
		}
	};
	const input = (
		<input
			ref={inputRef}
			type={type}
			defaultValue={initialValue}
			placeholder={placeholder}
			aria-label={ariaLabel}
			data-testid={testid}
			disabled={disabled}
			min={min}
			max={max}
			step={step}
			onInput={() => {
				dirty.current = true;
				revision.current++;
			}}
			onBlur={(e) => { void commit(e.currentTarget); }}
			onKeyDown={(e) => {
				if (e.key === "Enter" && !isComposing(e)) void commit(e.currentTarget);
				if (e.key === "Escape" && !isComposing(e) && (dirty.current || (type === "number" && e.currentTarget.validity?.badInput))) {
					// An edit in progress: Esc reverts it and is this field's one
					// action — the dialog behind stays open. React listens at the
					// document root, so stop the dialog's document listener too.
					e.preventDefault();
					e.stopPropagation();
					e.nativeEvent.stopImmediatePropagation();
					revert(e.currentTarget);
				}
			}}
			className="h-7 w-40 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
		/>
	);
	// One wrapper either way: toggling the error must not remount the
	// input, or it loses focus.
	return (
		<span className="flex flex-col items-end gap-1">
			{input}
			{error && (
				<span role="alert" data-testid={testid ? `${testid}-error` : undefined} className="max-w-60 text-right text-xs text-red-500">
					{error}
				</span>
			)}
		</span>
	);
}