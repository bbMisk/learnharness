"use client";

/** Typed-but-unsent text survives reloads and app restarts (owner, 2026-11-01):
 *  the composer, open questions' fields, reading notes and practice thinking.
 *  Small JSON in localStorage, written 300 ms after typing pauses, removed
 *  once sent or answered. Storage failures only cost the autosave. */
const PREFIX = "lh:draft:";
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function storage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

export function readDraft<T>(key: string): T | undefined {
	try {
		const raw = storage()?.getItem(PREFIX + key);
		return raw ? (JSON.parse(raw) as T) : undefined;
	} catch {
		return undefined;
	}
}

/** Saves after a pause; an empty string or undefined removes the draft. */
export function writeDraft(key: string, value: unknown, delayMs = 300): void {
	clearTimeout(timers.get(key));
	timers.set(
		key,
		setTimeout(() => {
			timers.delete(key);
			try {
				if (value === undefined || value === "") storage()?.removeItem(PREFIX + key);
				else storage()?.setItem(PREFIX + key, JSON.stringify(value));
			} catch {
				/* Full or blocked storage: the draft stays in this page only. */
			}
		}, delayMs),
	);
}

export function clearDraft(key: string): void {
	clearTimeout(timers.get(key));
	timers.delete(key);
	try {
		storage()?.removeItem(PREFIX + key);
	} catch {
		/* Nothing to clear. */
	}
}

/** Removes every draft under `prefix` except `keep` (answered questions). */
export function clearDrafts(prefix: string, keep?: string): void {
	const store = storage();
	if (!store) return;
	try {
		const doomed: string[] = [];
		for (let i = 0; i < store.length; i++) {
			const key = store.key(i);
			if (key?.startsWith(PREFIX + prefix) && key !== PREFIX + keep) doomed.push(key.slice(PREFIX.length));
		}
		doomed.forEach(clearDraft);
	} catch {
		/* Leave them; they are small. */
	}
}
