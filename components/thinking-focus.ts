"use client";

import { useEffect, useState, type RefObject } from "react";
import { FACTORY_SETTINGS, type UserSettings } from "@/src/core";
import { useSettingsSaved } from "@/components/settings-signal";

/** "Keep cursor in Your thinking" (owner, 2026-10-31): during a question,
 *  typing, pasting and dictation land in the thinking field. A question that
 *  arrives while the learner types in the composer takes the cursor there,
 *  and pointer clicks on the question's own controls (options, "I don't
 *  know", the confidence slider) hand it back. Keyboard navigation (Tab
 *  between rows) is untouched: only pointer interactions return focus. */

const TEXT_FIELD =
	'[contenteditable="true"], textarea, input:not([type="range"]):not([type="radio"]):not([type="checkbox"]):not([type="button"])';
const CONTROL = 'button, input, label, [role="radio"], [role="checkbox"], [data-kbdrow]';

// The question replaces the composer, so a question that arrives mid-typing
// finds focus already gone: remember where the learner last typed.
let lastTyped: "composer" | "elsewhere" | null = null;
if (typeof document !== "undefined") {
	document.addEventListener(
		"focusin",
		(event) => {
			const target = event.target instanceof Element ? event.target : null;
			if (!target?.matches(TEXT_FIELD)) return;
			lastTyped = target.closest('[data-testid="composer"]') ? "composer" : "elsewhere";
		},
		true,
	);
}

let preference: boolean = FACTORY_SETTINGS.general.keepThinkingFocus;
let loaded: Promise<void> | undefined;
function loadPreference(): Promise<void> {
	return fetch("/api/settings")
		.then((r) => (r.ok ? (r.json() as Promise<{ settings?: UserSettings | null }>) : Promise.reject()))
		.then((body) => {
			preference = body.settings?.general?.keepThinkingFocus ?? FACTORY_SETTINGS.general.keepThinkingFocus;
		})
		.catch(() => undefined);
}

function useKeepThinkingFocus(): boolean {
	const [enabled, setEnabled] = useState(preference);
	useEffect(() => {
		let alive = true;
		void (loaded ??= loadPreference()).then(() => alive && setEnabled(preference));
		return () => {
			alive = false;
		};
	}, []);
	useSettingsSaved((section) => {
		if (section !== "general") return;
		loaded = loadPreference();
		void loaded.then(() => setEnabled(preference));
	});
	return enabled;
}

/** Focus the field and put the caret back where it was, else at the end. */
function restore(field: HTMLElement | null, saved: Range | null): void {
	if (!field?.isConnected) return;
	field.focus({ preventScroll: true });
	const selection = document.getSelection?.();
	if (!selection) return;
	selection.removeAllRanges();
	if (saved && field.contains(saved.startContainer)) selection.addRange(saved);
	else {
		const end = document.createRange();
		end.selectNodeContents(field);
		end.collapse(false);
		selection.addRange(end);
	}
}

export function useThinkingFocus(root: RefObject<HTMLElement | null>, thinking: RefObject<HTMLElement | null>, active: boolean): void {
	const enabled = useKeepThinkingFocus();

	useEffect(() => {
		if (!enabled || !active) return;
		const current = document.activeElement;
		const focusGone = !current || current === document.body;
		if (lastTyped === "composer" && (focusGone || current?.closest('[data-testid="composer"]'))) restore(thinking.current, null);
	}, [enabled, active, thinking]);

	useEffect(() => {
		const dock = root.current;
		if (!enabled || !active || !dock) return;
		let saved: Range | null = null;
		let pending = false;
		const remember = () => {
			const selection = document.getSelection?.();
			if (selection?.rangeCount && thinking.current?.contains(selection.anchorNode)) saved = selection.getRangeAt(0).cloneRange();
		};
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target instanceof Element ? event.target : null;
			if (!target || thinking.current?.contains(target) || target.closest(TEXT_FIELD)) return;
			if (target.closest(CONTROL)) pending = true;
		};
		const onPointerUp = () => {
			if (!pending) return;
			pending = false;
			requestAnimationFrame(() => {
				// A control that moved the cursor into its own field (the "Other…" row) keeps it.
				const now = document.activeElement;
				if (now instanceof Element && now.matches(TEXT_FIELD) && !thinking.current?.contains(now)) return;
				restore(thinking.current, saved);
			});
		};
		document.addEventListener("selectionchange", remember);
		dock.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("pointerup", onPointerUp, true);
		return () => {
			document.removeEventListener("selectionchange", remember);
			dock.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("pointerup", onPointerUp, true);
		};
	}, [enabled, active, root, thinking]);
}
