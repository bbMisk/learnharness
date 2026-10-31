"use client";

import { useRef, useState } from "react";
import { useChatDrop } from "@/components/chat-drag";
import type { ChatListItem, ProjectSummary } from "@/src/core";

/** Pin, archive and project moves for the sessions sidebar and project pages. Updates
 * run one at a time in request order; each success refreshes the list. A chat dropped
 * on `chatDrop` moves to `dropProjectId` (the unassigned list when absent). */
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
	const updateChat = (id: string, changes: { pinned?: boolean; archived?: boolean; projectId?: string | null }) => {
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
			}
		};
		return (updateQueue.current = updateQueue.current.then(apply, apply));
	};

	const moveChat = (id: string, projectId: string | null) => {
		const chat = chats?.find((chat) => chat.id === id);
		if (!chat || (chat.projectId ?? null) === projectId) return;
		setMoveStatus("Moving chat…");
		void updateChat(id, { projectId }).then((saved) =>
			setMoveStatus(
				saved ? `Moved to ${projectId ? (projects.find((project) => project.id === projectId)?.name ?? "project") : "Chats"}.` : "",
			),
		);
	};
	const chatDrop = useChatDrop((id) => moveChat(id, dropProjectId));
	return { updateError, moveStatus, updateChat, moveChat, chatDrop };
}
