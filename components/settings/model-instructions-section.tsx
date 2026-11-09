"use client";
import { useEffect, useMemo, useState } from "react";
import {
	MODEL_INSTRUCTIONS_MAX,
	modelInstructionsKey,
	suggestedModelInstructions,
	type AgentSettings,
	type ModelCatalogEntry,
} from "@/src/core";
import { SettingsGroup, ThinSelect } from "./controls";

/** Unsaved drafts per model, kept for the app session: switching models or
 *  closing Settings never throws typed text away. */
const drafts = new Map<string, string>();

/** Optional per-model tutor instructions (core/model-instructions.ts). */
export function ModelInstructionsSection({
	agent,
	catalog,
	onChange,
}: {
	agent: AgentSettings | undefined;
	catalog: ModelCatalogEntry[] | undefined;
	onChange: (next: AgentSettings) => void;
}) {
	const saved = useMemo(() => agent?.modelInstructions ?? {}, [agent?.modelInstructions]);
	// Every catalog model, plus saved ones whose provider left the catalog
	// (so their text can still be read and cleared).
	const options = useMemo(() => {
		const list = (catalog ?? []).map((m) => ({ key: modelInstructionsKey(m), id: m.id, label: `${m.name} (${m.provider})` }));
		for (const key of Object.keys(saved)) {
			if (!list.some((o) => o.key === key)) list.push({ key, id: key.slice(key.indexOf(":") + 1), label: key });
		}
		return list;
	}, [catalog, saved]);
	const [selected, setSelected] = useState<string>("");
	const key = options.some((o) => o.key === selected) ? selected : Object.keys(saved)[0] || options[0]?.key || "";
	const savedText = saved[key] ?? "";
	const [text, setText] = useState(drafts.get(key) ?? savedText);
	// Follow the model or ITS saved text, keeping that model's unsaved draft.
	useEffect(() => setText(drafts.get(key) ?? savedText), [key, savedText]);
	const edit = (value: string) => {
		if (value === savedText) drafts.delete(key);
		else drafts.set(key, value);
		setText(value);
	};
	const suggestion = suggestedModelInstructions(options.find((o) => o.key === key)?.id ?? "");
	const save = (value: string) => {
		drafts.delete(key);
		const next = { ...saved };
		if (value.trim()) next[key] = value;
		else delete next[key];
		onChange({ ...agent, modelInstructions: next });
	};
	return (
		<SettingsGroup label="Model instructions" testid="group-model-instructions">
			<p className="text-xs text-muted-foreground/70">
				Optional. Extra teaching instructions for one model, added to the tutor&apos;s instructions whenever that model teaches.
				Models with no instructions behave as usual.
			</p>
			{options.length === 0 ? (
				<p className="text-xs text-muted-foreground">Connect a model provider to add instructions.</p>
			) : (
				<div className="space-y-2 py-1">
					<ThinSelect
						ariaLabel="Model"
						testid="model-instructions-model"
						value={key}
						onChange={setSelected}
						className="w-full min-w-0"
					>
						{options.map((o) => (
							<option key={o.key} value={o.key}>
								{saved[o.key] ? `${o.label} ·` : o.label}
							</option>
						))}
					</ThinSelect>
					<textarea
						aria-label="Instructions for this model"
						data-testid="model-instructions-text"
						rows={4}
						maxLength={MODEL_INSTRUCTIONS_MAX}
						value={text}
						onChange={(event) => edit(event.target.value)}
						placeholder="For example: slow down, and lead with a concrete example before the formal statement."
						className="lh-input w-full resize-y rounded-lg border bg-background p-3 text-sm"
					/>
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							disabled={text === savedText}
							onClick={() => save(text)}
							className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
						>
							Save instructions
						</button>
						{suggestion && !text.trim() && (
							<button
								type="button"
								data-testid="model-instructions-suggest"
								onClick={() => edit(suggestion)}
								className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
							>
								Insert suggested text
							</button>
						)}
					</div>
				</div>
			)}
		</SettingsGroup>
	);
}
