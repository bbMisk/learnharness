/** The round ↓ "scroll to bottom" button is icon-only, so it needs an accessible name. */
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Conversation, ConversationScrollButton } from "../components/ai-elements/conversation.tsx";

it("the scroll-to-bottom button is labelled", () => {
	const notAtBottom = {
		isAtBottom: false,
		escapedFromLock: true,
		scrollRef: { current: null },
		contentRef: { current: null },
		scrollToBottom: () => true,
		stopScroll: () => {},
		state: {},
	};
	const html = renderToStaticMarkup(
		<Conversation instance={notAtBottom as never}>
			<ConversationScrollButton />
		</Conversation>,
	);
	assert.match(html, /<button[^>]*aria-label="Scroll to bottom"/);
});
