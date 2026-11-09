"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { NotFoundView } from "@/components/not-found-view";
import { useServerEvent, useServerResync } from "@/components/server-events";

/** Keeps an open chat honest about its record: re-read on mount (browser
 *  Back can restore a cached page), on chats-changed and on reconnect. A 404
 *  (deleted here or in another window) swaps the chat for the not-found
 *  page; a new title (renamed in another window) goes out as lh:chat-renamed,
 *  which the header and sidebar already follow. Only the newest read counts. */
export function ChatGate({ chatId, title, children }: { chatId: string; title: string; children: ReactNode }) {
	const [gone, setGone] = useState(false);
	const known = useRef(title);
	const latest = useRef(0);
	const check = useCallback(async () => {
		const read = ++latest.current;
		try {
			const response = await fetch(`/api/chats/${chatId}?only=title`, { cache: "no-store" });
			if (read !== latest.current) return;
			if (response.status === 404) return setGone(true);
			if (!response.ok) return;
			const next = ((await response.json()) as { title?: unknown }).title;
			if (read !== latest.current || typeof next !== "string" || next === known.current) return;
			known.current = next;
			window.dispatchEvent(new CustomEvent("lh:chat-renamed", { detail: { id: chatId, title: next } }));
		} catch {
			// Offline: keep the view; the reconnect re-reads.
		}
	}, [chatId]);
	useEffect(() => {
		void check();
	}, [check]);
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			if (id === chatId) known.current = title;
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, [chatId]);
	useServerEvent("chats-changed", () => void check());
	useServerResync(() => void check());
	return gone ? <NotFoundView /> : children;
}
