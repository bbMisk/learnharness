"use client";

import { useEffect, useState, type DragEvent } from "react";

export const CHAT_DRAG_TYPE = "application/x-learnharness-chat";

export function startChatDrag(event: DragEvent, id: string) {
	event.dataTransfer.setData(CHAT_DRAG_TYPE, id);
	event.dataTransfer.effectAllowed = "move";
}

/** Chat moves use a distinct payload so file drops keep their existing owner. */
export function useChatDrop(move: (id: string) => void) {
	const [over, setOver] = useState(false);
	useEffect(() => {
		const reset = () => setOver(false);
		document.addEventListener("dragend", reset);
		return () => document.removeEventListener("dragend", reset);
	}, []);
	const accepts = (event: DragEvent) => Array.from(event.dataTransfer.types).includes(CHAT_DRAG_TYPE);
	return {
		over,
		handlers: {
			onDragOver(event: DragEvent<HTMLElement>) {
				if (!accepts(event)) return;
				event.preventDefault(); event.stopPropagation();
				event.dataTransfer.dropEffect = "move";
				setOver(true);
			},
			onDragLeave(event: DragEvent<HTMLElement>) {
				if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOver(false);
			},
			onDrop(event: DragEvent<HTMLElement>) {
				if (!accepts(event)) return;
				event.preventDefault(); event.stopPropagation(); setOver(false);
				const id = event.dataTransfer.getData(CHAT_DRAG_TYPE);
				if (/^chat_[A-Za-z0-9_-]+$/.test(id)) move(id);
			},
		},
	};
}
