"use client";

import { useEffect, useRef, useState } from "react";

/** Rename a project, guarding against an edit from another Mac (the route compares `expected`). */
export async function renameProject(id: string, name: string, expected: string): Promise<void> {
	const response = await fetch("/api/projects/" + id, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, expected: { name: expected } }),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error || "Could not rename the project.");
	}
}

/** An in-place name field (owner, 2026-11-01): Enter or leaving the field
 *  saves, Escape cancels; an unchanged or empty name just closes it. */
export function InlineRename({
	value,
	onCommit,
	onDone,
	ariaLabel,
	className,
}: {
	value: string;
	onCommit: (name: string) => Promise<void>;
	onDone: () => void;
	ariaLabel: string;
	className?: string;
}) {
	const [saving, setSaving] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const finished = useRef(false);
	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	const finish = async (save: boolean) => {
		if (finished.current) return;
		finished.current = true;
		const name = input.current?.value.trim() ?? "";
		if (save && name && name !== value) {
			setSaving(true);
			try {
				await onCommit(name);
			} catch {
				/* The caller reports the error; the old name stays. */
			}
		}
		onDone();
	};
	return (
		<input
			ref={input}
			aria-label={ariaLabel}
			defaultValue={value}
			maxLength={200}
			disabled={saving}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					void finish(true);
				} else if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					void finish(false);
				}
			}}
			onBlur={() => void finish(true)}
			className={"lh-input lh-no-drag min-w-0 rounded-md border border-border bg-card/50 px-2 " + (className ?? "")}
		/>
	);
}
