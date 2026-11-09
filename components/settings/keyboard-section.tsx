"use client";
/**
 * The Keyboard section (thin settings wave): view / rebind / reset over
 * core/keyboard.ts's registry. The overrides persist in localStorage
 * (lh:keymap, overrides-only, merged over DEFAULT_BINDINGS), so rebinding
 * is INSTANT — the dispatcher reads the map per keydown, no reload.
 *
 * Rebind flow: click Rebind → the row listens for the next keydown
 * (capture phase, preventDefault — nothing types anywhere), eventBinding
 * normalizes it, saveOverrides persists. Escape cancels. displayOnly
 * actions (a surface owns those keys — the question dock's row machine)
 * are listed for reading but never rebindable.
 *
 * A binding another action already uses is refused with a message naming
 * that action (see conflictFor); system/editing chords and bare keys are
 * refused too (see refusalFor).
 */

import { useEffect, useState } from "react";
import {
	KEYBOARD_ACTIONS,
	eventBinding,
	IS_MAC,
	formatBinding,
	loadOverrides,
	saveOverrides,
	type KeyAction,
	type KeyScope,
} from "@/src/core";
import { SettingsRow } from "./controls.tsx";

const SCOPES: { scope: KeyScope; label: string }[] = [
	{ scope: "global", label: "Global" },
	{ scope: "chat", label: "Chat" },
	{ scope: "graph", label: "Graph" },
];

/** The overrides map after ONE change (pure — exported for tests):
 *  binding null = reset the action to its default (key removed). */
export function nextOverrides(
	current: Partial<Record<KeyAction, string>>,
	id: KeyAction,
	binding: string | null,
): Partial<Record<KeyAction, string>> {
	const next = { ...current };
	if (binding === null) delete next[id];
	else next[id] = binding;
	return next;
}

/** The other action already bound to `binding`, if any (pure — exported
 *  for tests). */
export function conflictFor(
	overrides: Partial<Record<KeyAction, string>>,
	id: KeyAction,
	binding: string,
) {
	return KEYBOARD_ACTIONS.find((a) => a.id !== id && (overrides[a.id] ?? a.binding) === binding);
}

/** Copy, paste, undo, select all, close window, quit and reload, plus the
 *  desktop app's menu chords (electron/main.cjs): hide, hide others,
 *  minimize, zoom (Zoom In is ⌘+, typed as ⌘⇧= on US keyboards), and the
 *  developer tools. */
const RESERVED = new Set([
	"mod+c", "mod+v", "mod+x", "mod+z", "mod+shift+z", "mod+y", "mod+a", "mod+w", "mod+q", "mod+r",
	"mod+h", "mod+alt+h", "mod+m", "mod+0", "mod+-", "mod+=", "mod++", "mod+shift++", "mod+alt+i", "mod+shift+i",
]);

/** Why `binding` can't be a shortcut for `id`, if it can't (pure — exported
 *  for tests): a reserved system/editing chord, or a bare key that would
 *  fire while typing or editing. F-keys (with or without ⇧) and the action's
 *  own default pass. */
export function refusalFor(id: KeyAction, binding: string): string | null {
	if (RESERVED.has(binding)) return `${formatBinding(binding)} is reserved for the system or editing`;
	const own = KEYBOARD_ACTIONS.find((a) => a.id === id)?.binding;
	if (binding === own || /^(mod|alt)\+/.test(binding) || /^(shift\+)?f([1-9]|1[0-2])$/.test(binding)) return null;
	return `${formatBinding(binding)} needs ${IS_MAC ? "⌘ or ⌥" : "Ctrl or Alt"} (or use an F key)`;
}

export function KeyboardSection() {
	const [overrides, setOverrides] = useState<Partial<Record<KeyAction, string>>>({});
	const [rebinding, setRebinding] = useState<KeyAction | null>(null);
	const [nonce, setNonce] = useState(0);
	const [conflict, setConflict] = useState<{ id: KeyAction; text: string } | null>(null);
	const [confirmReset, setConfirmReset] = useState(false);

	// localStorage is read post-mount (SSR-safe); `nonce` re-reads after writes.
	useEffect(() => {
		setOverrides(loadOverrides());
	}, [nonce]);

	// The capture listener — only while a rebind is armed.
	useEffect(() => {
		if (!rebinding) return;
		const onKey = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") {
				setRebinding(null);
				return;
			}
			// Modifier keydowns arrive one by one (⌘ down, then ⇧, then the
			// key) — each is a keydown this capture listener sees. They are
			// not bindings; keep listening for the real key.
			if (e.key === "Control" || e.key === "Meta" || e.key === "Alt" || e.key === "Shift") return;
			const binding = eventBinding(e);
			if (!binding) return;
			const current = loadOverrides();
			const taken = conflictFor(current, rebinding, binding);
			const refused = taken ? `${formatBinding(binding)} is already used by ${taken.label}` : refusalFor(rebinding, binding);
			setRebinding(null);
			if (refused) {
				setConflict({ id: rebinding, text: refused });
				return;
			}
			setConflict(null);
			saveOverrides(nextOverrides(current, rebinding, binding));
			setNonce((n) => n + 1);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [rebinding]);

	function resetOne(id: KeyAction) {
		saveOverrides(nextOverrides(loadOverrides(), id, null));
		setNonce((n) => n + 1);
	}

	// Reset all takes two clicks: the first arms it, the second resets.
	function resetAll() {
		if (!confirmReset) {
			setConfirmReset(true);
			return;
		}
		setConfirmReset(false);
		saveOverrides({});
		setNonce((n) => n + 1);
	}

	const overridden = (id: KeyAction) => overrides[id] !== undefined;

	return (
		<>
			{SCOPES.map(({ scope, label }) => {
				const actions = KEYBOARD_ACTIONS.filter((a) => a.scope === scope);
				if (!actions.length) return null;
				return (
					<div key={scope} data-testid={`kbd-scope-${scope}`}>
						<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">{label}</p>
						<div className="flex flex-col gap-2">
							{actions.map((def) => {
								const effective = overrides[def.id] ?? def.binding;
								return (
									<SettingsRow
										key={def.id}
										label={def.label}
										hint={conflict?.id === def.id ? <span role="alert" className="text-red-500">{conflict.text}</span> : def.displayOnly ? "Fixed — part of this screen" : undefined}
										testid={`kbd-row-${def.id}`}
									>
										<span className="flex items-center gap-2">
											<kbd className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-ui text-xs">
												{rebinding === def.id ? "Press keys…" : formatBinding(effective) || "Not bound"}
											</kbd>
											{def.displayOnly ? null : rebinding === def.id ? (
												<button
													type="button"
													onClick={() => setRebinding(null)}
													className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
												>
													Cancel
												</button>
											) : (
												<>
													<button
														type="button"
														onClick={() => setRebinding(def.id)}
														data-testid={`kbd-rebind-${def.id}`}
														className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
													>
														Rebind
													</button>
													{overridden(def.id) && (
														<button
															type="button"
															onClick={() => resetOne(def.id)}
															data-testid={`kbd-reset-${def.id}`}
															className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
														>
															Reset
														</button>
													)}
												</>
											)}
										</span>
									</SettingsRow>
								);
							})}
						</div>
					</div>
				);
			})}
			<div className="mt-1 flex items-center justify-between">
				<span className="text-xs text-muted-foreground/70">Stored on this device (lh:keymap) — overrides only.</span>
				<button
					type="button"
					onClick={resetAll}
					onBlur={() => setConfirmReset(false)}
					data-testid="kbd-reset-all"
					className={`text-xs underline-offset-2 hover:underline ${confirmReset ? "text-red-500" : "text-muted-foreground hover:text-foreground"}`}
				>
					{confirmReset ? "Confirm reset all" : "Reset all to defaults"}
				</button>
			</div>
		</>
	);
}
