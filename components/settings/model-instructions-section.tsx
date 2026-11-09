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
	strong,
	onChange,
}: {
	agent: AgentSettings | undefined;
	catalog: ModelCatalogEntry[] | undefined;
	/** The Strong slot's model: the picker starts there when nothing is saved. */
	strong?: { provider: string; id: string };
	/** Queues a save composed on the latest saved settings; resolves whether it landed. */
	onChange: (compose: (base: AgentSettings | undefined) => AgentSettings) => void | Promise<boolean>;
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
	const strongKey = strong && options.some((o) => o.key === modelInstructionsKey(strong)) ? modelInstructionsKey(strong) : "";
	const key = options.some((o) => o.key === selected) ? selected : Object.keys(saved)[0] || strongKey || options[0]?.key || "";
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
		const model = key;
		const saving = onChange((base) => {
			const next = { ...base?.modelInstructions };
			if (value.trim()) next[model] = value;
			else delete next[model];
			return { ...base, modelInstructions: next };
		});
		// The draft goes only once the save lands: a failed save keeps it.
		void Promise.resolve(saving).then((ok) => {
			if (ok !== false && drafts.get(model) === value) drafts.delete(model);
		});
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
