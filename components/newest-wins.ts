"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** One applier per save: call it with the value the server confirmed. */
export type NewestApply<T> = (value: T) => void;

/** Backoff for the post-save reconcile read (ms before each retry). */
export const RECONCILE_RETRY_MS = [250, 500, 1000, 2000, 4000] as const;

/**
 * A server-confirmed value that several reads and saves race to set (owner,
 * 2026-11-03 — the lesson's question type and cram style).
 *
 * Every read and save takes a ticket when it STARTS; a result lands only if
 * no later-started one has landed first, so a slow response never restores
 * a value a newer read replaced. A read that started BEFORE a save can still
 * outrank it (it read the old value), so every confirmed save is followed by
 * a reconcile read — started after the commit, so it sees the save or
 * anything newer from another window — retried with backoff until one lands
 * or something started after the commit already has. Unmount stops it all.
 */
export function useNewestWins<T>(initial: T, read: () => Promise<T>) {
	const [value, setValue] = useState(initial);
	const issued = useRef(0);
	const applied = useRef(0);
	const alive = useRef(true);
	const readRef = useRef(read);
	readRef.current = read;
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const begin = useCallback((): NewestApply<T> => {
		const ticket = ++issued.current;
		return (next) => {
			if (!alive.current || ticket < applied.current) return;
			applied.current = ticket;
			setValue(() => next);
		};
	}, []);

	/** One read of the server's value; false when it failed. */
	const refresh = useCallback(async (): Promise<boolean> => {
		const apply = begin();
		try {
			apply(await readRef.current());
			return true;
		} catch {
			return false;
		}
	}, [begin]);

	const beginSave = useCallback((): NewestApply<T> => {
		const apply = begin();
		return (confirmed) => {
			apply(confirmed);
			const committed = issued.current;
			const settled = () => !alive.current || applied.current > committed;
			void (async () => {
				for (let attempt = 0; attempt <= RECONCILE_RETRY_MS.length; attempt++) {
					if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RECONCILE_RETRY_MS[attempt - 1]));
					if (settled() || (await refresh())) return;
				}
			})();
		};
	}, [begin, refresh]);

	return { value, refresh, beginSave };
}
