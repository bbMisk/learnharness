"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useChatDrop } from "@/components/chat-drag";
import type { ChatListItem, ProjectSummary } from "@/src/core";

type ChatChanges = { pinned?: boolean; archived?: boolean; projectId?: string | null };
const LINE_MS = 6000;

/** Pin, archive and project moves for the sessions sidebar and project pages. Updates
 * run one at a time in request order; each success refreshes the list. `chats` comes
 * back as `view` with unsaved changes applied, so a click shows at once and the
 * newest click on a chat wins. A chat dropped on `chatDrop` moves to `dropProjectId`
 * (the unassigned list when absent). */
export function useChatOrganization({
	chats,
	projects,
	refresh,
	dropProjectId = null,
}: {
	chats: ChatListItem[] | null;
	projects: ProjectSummary[];
	refresh: () => Promise<void>;
	dropProjectId?: string | null;
}) {
	const [updateError, setUpdateError] = useState<string | null>(null);
	const [moveStatus, setMoveStatus] = useState("");
	const updateQueue = useRef<Promise<unknown>>(Promise.resolve());
	// The status and error lines are transient: they clear a few seconds after
	// they last changed (a fix offline, a later success elsewhere, a drop).
	useEffect(() => {
		if (!updateError && !moveStatus) return;
		const timer = setTimeout(() => {
			setUpdateError(null);
			setMoveStatus("");
		}, LINE_MS);
		return () => clearTimeout(timer);
	}, [updateError, moveStatus]);
	// Unsaved changes per chat, and the newest update's number per chat.
	const [pending, setPending] = useState<Record<string, ChatChanges>>({});
	const latest = useRef<Record<string, number>>({});
	const view = useMemo(
		() =>
			chats &&
			chats.map((chat) => {
				const changes = pending[chat.id];
				if (!changes) return chat;
				const { projectId, ...flags } = changes;
				return { ...chat, ...flags, ...(projectId !== undefined ? { projectId: projectId ?? undefined } : {}) };
			}),
		[chats, pending],
	);
	const updateChat = (id: string, changes: ChatChanges) => {
		const ticket = (latest.current[id] ?? 0) + 1;
		latest.current[id] = ticket;
		setPending((prev) => ({ ...prev, [id]: { ...prev[id], ...changes } }));
		const apply = async () => {
			setUpdateError(null);
			try {
				const response = await fetch(`/api/chats/${id}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(changes),
				});
				if (!response.ok) throw new Error();
				await refresh();
				return true;
			} catch {
				setUpdateError("Chat could not be updated. Try again.");
				return false;
			} finally {
				// The newest update has landed (or failed): the list is the truth again.
				if (latest.current[id] === ticket) setPending(({ [id]: _, ...rest }) => rest);
			}
		};
		return (updateQueue.current = updateQueue.current.then(apply, apply));
	};

	const moveChat = (id: string, projectId: string | null) => {
		// Skip only a known no-op: a chat dropped before this list loads still moves.
		const chat = view?.find((chat) => chat.id === id);
		if (chat && (chat.projectId ?? null) === projectId) return;
		setMoveStatus("Moving chat…");
		void updateChat(id, { projectId }).then((saved) =>
			setMoveStatus(
				saved ? `Moved to ${projectId ? (projects.find((project) => project.id === projectId)?.name ?? "project") : "Chats"}.` : "",
			),
		);
	};
	const chatDrop = useChatDrop((id) => moveChat(id, dropProjectId));
	return { view, updateError, moveStatus, updateChat, moveChat, chatDrop };
}
