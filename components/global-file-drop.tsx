"use client";

import { useEffect, useState } from "react";

type DropTarget = {
	id: string;
	label: () => string;
	priority: () => number;
	element: () => HTMLElement | null;
	activate: () => void;
	canReveal: () => boolean;
	add: (files: File[]) => Promise<void>;
};
const targets = new Map<string, DropTarget>();
let focused: string | null = null;

export function registerFileDrop(target: DropTarget) {
	targets.set(target.id, target);
	return () => {
		targets.delete(target.id);
		if (focused === target.id) focused = null;
	};
}
export function focusFileDrop(id: string) {
	focused = id;
}

function visible(target: DropTarget) {
	const element = target.element();
	if (!element || !element.getClientRects().length) return false;
	const style = getComputedStyle(element);
	if (style.visibility === "hidden" || style.display === "none") return false;
	const input = element.matches("textarea,input") ? element : element.querySelector("textarea,input:not([type=file])");
	return !(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) || !input.disabled;
}

function destination(event: DragEvent) {
	// The drop shield also covers iframes. Look underneath it so dropping
	// directly on a field still owns that field, even when another was focused.
	for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
		const id = element.closest<HTMLElement>("[data-file-drop-id]")?.dataset.fileDropId;
		const target = id ? targets.get(id) : undefined;
		if (target && visible(target)) return target;
	}
	const available = [...targets.values()].sort((a, b) => b.priority() - a.priority());
	return available.find((t) => t.id === focused && visible(t)) ?? available.find((t) => visible(t) || t.canReveal());
}

/** A single drop owner prevents browser navigation and duplicate attachment. */
export function GlobalFileDrop() {
	const [over, setOver] = useState(false);
	const [label, setLabel] = useState("");
	const [error, setError] = useState("");
	useEffect(() => {
		let depth = 0;
		const files = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes("Files");
		const enter = (event: DragEvent) => {
			if (!files(event)) return;
			depth++;
			setLabel(destination(event)?.label() || "a chat");
			setOver(true);
		};
		const leave = () => {
			if (--depth <= 0) {
				depth = 0;
				setOver(false);
			}
		};
		const drag = (event: DragEvent) => {
			if (!files(event)) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
			setLabel(destination(event)?.label() || "a chat");
		};
		const drop = (event: DragEvent) => {
			if (!files(event)) return;
			event.preventDefault();
			event.stopPropagation();
			depth = 0;
			setOver(false);
			setError("");
			const target = destination(event);
			if (!target) {
				setError("Open a chat or project to add files.");
				return;
			}
			target.activate();
			void target.add(Array.from(event.dataTransfer?.files || [])).then(() => {
				const element = target.element();
				const input = element?.matches("textarea,input") ? element : element?.querySelector("textarea,input:not([type=file])");
				(input as HTMLElement | null)?.focus();
			});
		};
		window.addEventListener("dragenter", enter);
		window.addEventListener("dragleave", leave);
		window.addEventListener("dragover", drag);
		window.addEventListener("drop", drop, true);
		return () => {
			window.removeEventListener("dragenter", enter);
			window.removeEventListener("dragleave", leave);
			window.removeEventListener("dragover", drag);
			window.removeEventListener("drop", drop, true);
		};
	}, []);
	return (
		<>
			{over && (
				<div
					data-testid="app-file-drop-overlay"
					className="fixed inset-0 z-[200] flex items-center justify-center border-2 border-primary bg-background/85"
				>
					<div className="pointer-events-none rounded-2xl border bg-card px-8 py-6 font-prose text-lg shadow-xl">
						Add files to {label}
					</div>
				</div>
			)}
			{error && (
				<div role="alert" className="fixed bottom-5 right-5 z-[210] rounded-xl border bg-card p-4 text-sm">
					{error}
					<button className="ml-4" onClick={() => setError("")} aria-label="Dismiss file drop message">
						×
					</button>
				</div>
			)}
		</>
	);
}
