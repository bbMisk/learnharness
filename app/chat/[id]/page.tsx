import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { ChatGate } from "@/components/chat-gate";
import { clientMessage, resolveSettings, sanitizeQuestionType, slotsConfigured } from "@/src/core";
import { compactionInFlight, getChat, isTurnRunning, readSettingsRecord, turnFailure } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function ChatPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ prompt?: string }>;
}) {
	const [{ id }, { prompt }] = await Promise.all([params, searchParams]);
	const chat = getChat(id);
	if (!chat) notFound();
	// The persistent setup CTA's seed (BYOK, owner 2026-09-22): slotsConfigured
	// over the settings record, server-read — the same gate home/new read. The
	// server's 503 stays the truth; this only decides whether the pill rides.
	const record = readSettingsRecord();
	return (
		<ChatGate key={chat.id} chatId={chat.id} title={chat.title}>
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			kind={chat.kind ?? "teach"}
			style={chat.style}
			projectId={chat.projectId}
			// The lesson's question type (owner, 2026-11-03): the stored choice
			// and the app-wide mechanic an unset one falls back to.
			questionType={sanitizeQuestionType(chat.settings?.questionType)}
			agentTools={resolveSettings(record ?? null).agent.tools}
			// Wave D: the record IS native agent history — the client view is
				// derived app-side (core/view.ts projectView; GET serves the same
				// display messages).
				initialMessages={chat.messages.map(clientMessage)}
			initialError={turnFailure(chat.id)}
			initialConfigured={slotsConfigured(record?.models)}
			initialShowReadingThinking={resolveSettings(record ?? null).general.showReadingThinking}
			initialPrompt={prompt}
			// A teacher turn that outlived its client: the remounted view must
			// attach (busy shimmer + poll), never resurrect the stale record.
			initiallyInFlight={isTurnRunning(chat.id)}
			initiallyCompacting={compactionInFlight(chat.id)}
		/>
		</ChatGate>
	);
}
