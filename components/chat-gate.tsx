"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { NotFoundView } from "@/components/not-found-view";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { APP_TITLE } from "@/lib/utils";

/** Keeps an open chat honest about its record: re-read on mount (browser
 *  Back can restore a cached page), on chats-changed and on reconnect. A 404
 *  (deleted here or in another window) swaps the chat for the not-found
 *  page; a new title (renamed in another window) goes out as lh:chat-renamed,
 *  which the header and sidebar already follow. Only the newest read counts.
 *  The window title follows the chat's, and an archived chat says so. */
export function ChatGate({ chatId, title, archived: initiallyArchived = false, children }: { chatId: string; title: string; archived?: boolean; children: ReactNode }) {
	const [gone, setGone] = useState(false);
	const [shownTitle, setShownTitle] = useState(title);
	const [archived, setArchived] = useState(initiallyArchived);
	const [restoring, setRestoring] = useState(false);
	const known = useRef(title);
	const latest = useRef(0);
	const check = useCallback(async () => {
		if (latest.current < 0) return; // gone for good: stop re-reading
		const read = ++latest.current;
		try {
			const response = await fetch(`/api/chats/${chatId}?only=title`, { cache: "no-store" });
			if (read !== latest.current) return;
			if (response.status === 404) {
				latest.current = -1;
				return setGone(true);
			}
			if (!response.ok) return;
			const body = (await response.json()) as { title?: unknown; archived?: unknown };
			if (read !== latest.current) return;
			setArchived(body.archived === true);
			const next = body.title;
			if (typeof next !== "string" || next === known.current) return;
			known.current = next;
			setShownTitle(next);
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
			if (id !== chatId) return;
			known.current = title;
			setShownTitle(title);
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, [chatId]);
	// Leaving (or the chat going away) puts back the app title, never the
	// title found on mount: the server already set that to this chat's.
	useEffect(() => {
		if (gone) return;
		document.title = shownTitle;
		return () => {
			document.title = APP_TITLE;
		};
	}, [gone, shownTitle]);
	useServerEvent("chats-changed", () => void check());
	useServerResync(() => void check());
	const restore = async () => {
		setRestoring(true);
		try {
			const response = await fetch(`/api/chats/${chatId}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ archived: false }),
			});
			if (response.ok) setArchived(false);
		} catch {
			// Offline: the note stays; Restore can be pressed again.
		} finally {
			setRestoring(false);
		}
	};
	if (gone) return <NotFoundView message="This chat was deleted." />;
	return (
		<>
			{children}
			{archived && (
				<p
					role="status"
					data-testid="chat-archived"
					className="absolute left-1/2 top-[4.25rem] z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm"
				>
					This chat is archived.
					<button type="button" disabled={restoring} onClick={() => void restore()} className="text-foreground underline-offset-2 hover:underline disabled:opacity-40">
						Restore
					</button>
				</p>
			)}
		</>
	);
}
