"use client";

import { useCallback, useRef, useState } from "react";

/** One applier per read or save: call it with the confirmed value. */
export type NewestApply<T> = (value: T) => void;

/** A server-confirmed value that several reads and saves race to set
 *  (owner, 2026-11-03 — the lesson's question type and cram style). Each read
 *  or save calls `begin()` when it STARTS and applies its confirmed value
 *  through the returned applier; a result lands only if no later-started one
 *  has landed first. The newest confirmed value wins, so a slow response can
 *  never restore a value a newer read replaced. */
export function useNewestWins<T>(initial: T): [T, () => NewestApply<T>] {
	const [value, setValue] = useState(initial);
	const issued = useRef(0);
	const applied = useRef(0);
	const begin = useCallback((): NewestApply<T> => {
		const ticket = ++issued.current;
		return (next) => {
			if (ticket < applied.current) return;
			applied.current = ticket;
			setValue(() => next);
		};
	}, []);
	return [value, begin];
}
