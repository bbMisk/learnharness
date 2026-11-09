"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { NotFoundView } from "@/components/not-found-view";
import { useServerEvent, useServerResync } from "@/components/server-events";

const ArchivedContext = createContext(false);
/** The open chat is archived (here or in another window). */
export const useChatArchived = () => useContext(ArchivedContext);

/** Keeps an open chat honest about its record: re-read on mount (browser
 *  Back can restore a cached page), on chats-changed and on reconnect. A 404
 *  (deleted here or in another window) swaps the chat for the not-found
 *  page; a new title (renamed in another window) goes out as lh:chat-renamed,
 *  which the header and sidebar already follow; archived goes out through
 *  useChatArchived. Only the newest read counts. */
export function ChatGate({ chatId, title, archived: initiallyArchived = false, children }: { chatId: string; title: string; archived?: boolean; children: ReactNode }) {
	const [gone, setGone] = useState(false);
	const [archived, setArchived] = useState(initiallyArchived);
	const known = useRef(title);
	const latest = useRef(0);
	const check = useCallback(async () => {
		const read = ++latest.current;
		try {
			const response = await fetch(`/api/chats/${chatId}?only=title`, { cache: "no-store" });
			if (read !== latest.current) return;
			if (response.status === 404) return setGone(true);
			if (!response.ok) return;
			const body = (await response.json()) as { title?: unknown; archived?: unknown };
			if (read !== latest.current) return;
			setArchived(body.archived === true);
			const next = body.title;
			if (typeof next !== "string" || next === known.current) return;
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
	return gone ? <NotFoundView /> : <ArchivedContext.Provider value={archived}>{children}</ArchivedContext.Provider>;
}
