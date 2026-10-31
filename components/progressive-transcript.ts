"use client";

import { startTransition, useEffect, useMemo, useState } from "react";

/** Transcript parts rendered when a chat opens, and per background batch after. */
export const TRANSCRIPT_FIRST = 40;
export const TRANSCRIPT_BATCH = 10;

/**
 * Long transcripts open newest-first (owner, 2026-10-31): the newest parts
 * render with the page and older ones fill in above, one batch per commit,
 * so switching chats does not build every formula in the history before
 * first paint. Counted in parts, not messages, because one grouped
 * assistant message can hold most of a session. A message link (#hash)
 * needs every anchor at once, so it renders the whole transcript.
 */
export function useProgressiveTranscript(messages: readonly { parts: readonly unknown[] }[]) {
	const starts = useMemo(() => {
		const out = [0];
		for (const m of messages) out.push(out[out.length - 1]! + m.parts.length);
		return out;
	}, [messages]);
	const total = starts[starts.length - 1]!;
	const [fillFrom, setFillFrom] = useState(() => Math.max(0, total - TRANSCRIPT_FIRST));
	// The newest TRANSCRIPT_FIRST parts always render, even if the list is replaced.
	const renderFrom = Math.min(fillFrom, Math.max(0, total - TRANSCRIPT_FIRST));
	useEffect(() => {
		if (fillFrom === 0) return;
		if (window.location.hash) {
			setFillFrom(0);
			return;
		}
		// Effects run after paint; a transition is interruptible, so typing
		// and clicks stay responsive while the history fills in.
		startTransition(() => setFillFrom((from) => Math.max(0, from - TRANSCRIPT_BATCH)));
	}, [fillFrom]);
	return {
		/** Every part of message `mi` is still waiting to render. */
		hidesMessage: (mi: number) => starts[mi]! < renderFrom && starts[mi + 1]! <= renderFrom,
		/** Part `pi` of message `mi` is still waiting to render. */
		hidesPart: (mi: number, pi: number) => starts[mi]! + pi < renderFrom,
	};
}
