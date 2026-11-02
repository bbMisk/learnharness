"use client";

import type { CacheRetention } from "@earendil-works/pi-ai";

const OPTIONS = [
	{ value: undefined, compact: "default", label: "Provider default", description: "Send nothing; the provider and model decide how long the cache lasts." },
	{ value: "none", compact: "not requested", label: "Don’t request caching", description: "Ask for no caching where the provider allows it. Providers may still cache automatically." },
	{ value: "short", compact: "short", label: "Short retention", description: "The provider’s short cache: 5 minutes on Claude, the account default on ChatGPT." },
	{ value: "long", compact: "long", label: "Long retention", description: "Keep the cache across longer pauses. Cache writes cost more; see below." },
] as const;

/** What Long does for this slot's model (owner, 2026-11-01), from the providers' docs.
 *  The cost hints come from replaying this app's own lesson timing (docs/cache-retention.md). */
export function longRetentionNote(provider: string | undefined, modelId: string | undefined): string | undefined {
	const id = (modelId ?? "").toLowerCase();
	if (provider === "claude-code") return "Claude Code: Long asks for the 1-hour cache. On a Claude subscription the main conversation already gets 1 hour by default.";
	if (provider === "anthropic" || id.includes("claude")) return "Claude: Long keeps the cache 1 hour instead of 5 minutes. Writes cost 2× instead of 1.25×, but lessons with 5–60 minute pauses usually come out cheaper. Recommended.";
	const version = /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
	if (provider === "chatgpt" || provider === "openai") {
		if (!version) return "ChatGPT: Long is sent only for GPT models; this model keeps the default.";
		const [major, minor] = [Number(version[1]), Number(version[2] ?? 0)];
		if (major > 5 || (major === 5 && minor >= 6)) return "GPT-5.6 and later: the default already keeps 30 minutes. Long asks for 12 hours, with writes at 2.5×; for typical lessons that costs more than it saves. Keep the default.";
		return "GPT-5.5 and earlier: Long keeps the cache 24 hours at no extra write cost.";
	}
	return undefined;
}

export function cacheRetentionLabel(value: CacheRetention | undefined): string {
	return `Cache: ${OPTIONS.find((option) => option.value === value)!.compact}`;
}

export function CacheRetentionMenu({ value, onPick, provider, modelId }: {
	value: CacheRetention | undefined;
	onPick: (value: CacheRetention | undefined) => void;
	provider?: string;
	modelId?: string;
}) {
	const note = longRetentionNote(provider, modelId);
	return <>
		<div className="border-b border-border px-2 pb-2">
			<p className="text-card-foreground">Cache retention</p>
			<p className="mt-1 text-muted-foreground">How long the provider keeps this slot’s lesson cached between replies. A cached lesson is re-read cheaply instead of from scratch. This does not guarantee a cache hit.</p>
			{note && <p className="mt-1 text-card-foreground" data-testid="cache-retention-note">{note}</p>}
		</div>
		{OPTIONS.map((option) => <button
			key={option.value ?? "default"}
			type="button"
			data-testid={`cache-retention-option-${option.value ?? "default"}`}
			aria-pressed={value === option.value}
			onClick={() => onPick(option.value)}
			className={`rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted ${value === option.value ? "bg-muted/60" : ""}`}
		>
			<span className="flex justify-between gap-2 text-card-foreground"><span>{option.label}</span>{value === option.value && <span aria-hidden>✓</span>}</span>
			<span className="mt-1 block text-muted-foreground">{option.description}</span>
		</button>)}
	</>;
}
