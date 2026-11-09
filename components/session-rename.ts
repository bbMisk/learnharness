import { useCallback, useEffect, useRef, useState } from "react";
import { captureFocus, focusComposer } from "@/components/focus-return";

/**
 * The chat header's title and its click-to-rename state. Clicking the title
 * opens edit mode with everything selected. Enter or a click away commits
 * (PUT /api/chats/:id); Escape discards. The server never bumps updatedAt on a
 * rename (sidebar order must not churn); the sidebar updates instantly via the
 * lh:chat-renamed window event.
 */
export function useSessionRename(chatId: string, title: string) {
	const [titleText, setTitleText] = useState(title);
	const [renaming, setRenaming] = useState(false);
	const [titleDraft, setTitleDraft] = useState("");
	const titleInputRef = useRef<HTMLInputElement | null>(null);

	const commitRename = useCallback(
		async (next: string) => {
			setRenaming(false);
			const t = next.trim();
			if (t === "" || t === titleText) return; // empty commit = discard
			try {
				const res = await fetch(`/api/chats/${chatId}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: t }),
				});
				if (!res.ok) throw new Error(`rename failed: ${res.status}`);
				setTitleText(t);
				window.dispatchEvent(
					new CustomEvent("lh:chat-renamed", { detail: { id: chatId, title: t } }),
				);
			} catch (err) {
				console.error("rename failed:", err); // keep the old title
			}
		},
		[chatId, titleText],
	);

	// Select-all when edit mode opens: the click means "replace". Enter or
	// Esc hands focus back to what had it (the composer if nothing did).
	const returnFocus = useRef<ReturnType<typeof captureFocus>>(null);
	const closedByKey = useRef(false);
	useEffect(() => {
		if (renaming) {
			const el = titleInputRef.current;
			if (el) {
					returnFocus.current = captureFocus();
					el.focus();
					el.select();
					const onKey = (e: KeyboardEvent) => {
						if (e.key !== "Enter" && e.key !== "Escape") return;
						closedByKey.current = true;
						// The focus moves before Enter's default: keep it from typing a newline there.
						if (e.key === "Enter" && !e.isComposing) e.preventDefault();
					};
					el.addEventListener("keydown", onKey);
					return () => el.removeEventListener("keydown", onKey);
			}
		} else if (closedByKey.current) {
			closedByKey.current = false;
			if (!returnFocus.current?.(true)) focusComposer();
		}
	}, [renaming]);

	// F2 opens the title rename; F2 inside the open rename keeps its draft.
	useEffect(() => {
		const onRename = () => {
			if (renaming) return;
			setTitleDraft(titleText);
			setRenaming(true);
		};
		window.addEventListener("lh:kbd-rename-session", onRename);
		return () => window.removeEventListener("lh:kbd-rename-session", onRename);
	}, [titleText, renaming]);

	// The sidebar's inline rename dispatches the same lh:chat-renamed event:
	// if it renamed this chat, patch the header title in place.
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			if (id === chatId) setTitleText((prev) => (title !== prev ? title : prev));
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, [chatId]);

	return { titleText, renaming, setRenaming, titleDraft, setTitleDraft, titleInputRef, commitRename };
}
