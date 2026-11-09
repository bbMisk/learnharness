import { useCallback, useEffect, useRef, useState } from "react";
import { captureFocus, focusComposer } from "@/components/focus-return";
import { isComposing } from "@/components/ime";

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
	const [renameError, setRenameError] = useState("");
	const titleInputRef = useRef<HTMLInputElement | null>(null);
	// Enter or Esc closed the field (vs a click away); see the open effect.
	const closedByKey = useRef(false);
	// A failed click-away save reopens the field without taking focus back.
	const reopenQuietly = useRef(false);
	// Opening or closing the field clears a failed save's error.
	const setRenamingClear = useCallback((next: boolean) => {
		setRenameError("");
		setRenaming(next);
	}, []);

	const commitRename = useCallback(
		async (next: string) => {
			const byKey = closedByKey.current;
			setRenamingClear(false);
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
				// Keep the old title; reopen the field with what was typed.
				console.error("rename failed:", err);
				setTitleDraft(t);
				reopenQuietly.current = !byKey;
				setRenaming(true);
				setRenameError("Chat could not be renamed. Try again.");
			}
		},
		[chatId, titleText, setRenamingClear],
	);

	// Select-all when edit mode opens: the click means "replace". Enter or
	// Esc hands focus back to what had it (the composer if nothing did).
	const returnFocus = useRef<ReturnType<typeof captureFocus>>(null);
	useEffect(() => {
		if (renaming) {
			const el = titleInputRef.current;
			if (el) {
					if (!reopenQuietly.current) {
						returnFocus.current = captureFocus();
						el.focus();
						el.select();
					}
					reopenQuietly.current = false;
					const onKey = (e: KeyboardEvent) => {
						if (e.key !== "Enter" && e.key !== "Escape") return;
						if (e.key === "Enter" && isComposing(e)) return; // the IME's confirm, not a commit
						closedByKey.current = true;
						// The focus moves before Enter's default: keep it from typing a newline there.
						if (e.key === "Enter") e.preventDefault();
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

	return { titleText, renaming, setRenaming: setRenamingClear, titleDraft, setTitleDraft, titleInputRef, commitRename, renameError };
}
