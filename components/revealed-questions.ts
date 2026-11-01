"use client";

/** Checks the learner has already opened from behind "Check your understanding"
 *  (owner, 2026-11-01): switching chats and coming back, or reloading the
 *  window, must not hide them again. Kept for this browser session. */
const STORAGE_KEY = "lh:revealed-questions";
const LIMIT = 200;

function load(): string[] {
	try {
		const saved = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "[]");
		return Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : [];
	} catch {
		return [];
	}
}

let revealed: Set<string> | undefined;
const keys = () => (revealed ??= new Set(typeof window === "undefined" ? [] : load()));

export function wasRevealed(key: string | null): boolean {
	return key !== null && keys().has(key);
}

export function rememberRevealed(key: string | null): void {
	if (key === null || keys().has(key)) return;
	const set = keys();
	set.add(key);
	for (const oldest of set) {
		if (set.size <= LIMIT) break;
		set.delete(oldest);
	}
	try {
		window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
	} catch {
		/* The in-memory record still covers chat switches. */
	}
}
