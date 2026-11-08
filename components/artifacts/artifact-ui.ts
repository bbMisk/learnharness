"use client";

import { useContext, useState } from "react";
import { ChatActionsContext } from "@/components/chat-actions";

/**
 * A delivered artifact's brightness inversion (owner, 2026-10-07): the
 * switch state PERSISTS on its steer record (details.ui.inverted). Seeded
 * from `initialInverted`; a toggle updates at once and writes through the
 * silent artifact-ui route, failures swallowed (the local state stands).
 * Without a chat page (tests, previews, the activity dock) or a steer
 * message id, the toggle stays local-only.
 */
export function useArtifactInversion(messageId?: string, initialInverted = false): [boolean, (next: boolean) => void] {
	const chatId = useContext(ChatActionsContext)?.chatId;
	const [inverted, setInverted] = useState(initialInverted);
	const toggle = (next: boolean) => {
		setInverted(next);
		if (!chatId || !messageId) return;
		void fetch(`/api/chats/${chatId}/artifact-ui`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { messageId, inverted: next } }),
		}).catch(() => {});
	};
	return [inverted, toggle];
}
