import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, getToolStateChanges, toToolDeclaration, type Api, type Model, type SystemMessage } from "@earendil-works/pi-ai";
import { probeDoneResultIds, type LhMessage } from "../core/native-messages.ts";
import { activeCompactionOf, keptIndexFor } from "../core/compaction.ts";
import { CLAUDE_CODE_PROVIDER } from "./claude-code/constants.ts";

/**
 * SHARED HANDOFF PREFIX (opt-in experiment, Settings → General → Reuse the
 * probe's cache when teaching; default OFF).
 *
 * Today the teacher's requests start with the TEACHER's instructions and
 * tools, so the first teacher request re-reads the whole probe transcript
 * uncached, and the teacher keeps its own prefix for the rest of the lesson.
 * With the setting ON, a teacher request keeps the PROBER's prefix instead:
 * the prober's leading system message (its instructions + tool declarations,
 * exactly as the prober sent them) and the probe transcript stay
 * byte-identical at the start, and the teacher's instructions and tool
 * changes arrive as ONE mid-conversation system message at the handoff
 * point. Both messages are rebuilt from the saved record on EVERY teacher
 * run (system messages never persist — ui-stream's settle drops the role),
 * at a position that depends only on the record, so the prefix stays stable
 * for the whole lesson.
 *
 * Only where the transport can say this natively: mid-conversation system
 * messages AND in-place tool changes. Everywhere else the caller falls back
 * to today's teacher request.
 */

/** The header that precedes the teacher's full instructions in the update. */
export const HANDOFF_UPDATE_TEXT =
	"# Handoff: the probe is over, you are now the teacher\n\n" +
	"Everything above was the probing phase, run under the prober's instructions. Those instructions no longer apply. " +
	"From here on, follow the teacher's instructions below; they replace the prober's in full. Your tools changed with them.";

/** One agent's model-facing loadout: its system prompt and its tool registry. */
export interface AgentLoadout {
	systemPrompt: string;
	tools: readonly AgentTool<any>[];
}

/** Can this model take the teacher's instructions AND tool changes mid-conversation?
 *  Responses transports need both flags (pi's "changes" tool mode); Anthropic Messages
 *  needs native tool_addition/tool_removal blocks, or the top-level tool list (which
 *  precedes the system prompt in the cache order) would change anyway. Claude Code runs
 *  its own CLI transcript and is never eligible. */
export function sharedHandoffSupported(model: Model<Api>): boolean {
	if (model.provider === CLAUDE_CODE_PROVIDER) return false;
	const compat = (model.compat ?? {}) as {
		supportsMidConvoSystemMessages?: boolean;
		supportsAdditionalTools?: boolean;
		supportsMidConvoToolChanges?: boolean;
	};
	if (!compat.supportsMidConvoSystemMessages) return false;
	if (model.api === "openai-responses" || model.api === "openai-codex-responses") return compat.supportsAdditionalTools === true;
	if (model.api === "anthropic-messages") return compat.supportsMidConvoToolChanges === true;
	return false;
}

/**
 * Where the teacher's update goes, as an index into the record: directly after the
 * first concluded probe_done result and every adjacent result answering a call of the
 * same assistant message (a system message between one message's tool results would
 * split the batch on the wire). It depends only on messages the record already held
 * when the probe concluded, so it is the same on every later teacher run. Null when
 * the record has no concluded probe.
 */
export function handoffIndex(messages: readonly LhMessage[]): number | null {
	const concluded = probeDoneResultIds(messages);
	const at = messages.findIndex((m) => concluded.has(m.id));
	if (at < 0) return null;
	const callId = (messages[at] as { toolCallId: string }).toolCallId;
	const owner = messages.slice(0, at).findLast((m) =>
		m.role === "assistant" && m.content.some((block) => block.type === "toolCall" && block.id === callId));
	const siblings = new Set(owner?.role === "assistant"
		? owner.content.flatMap((block) => block.type === "toolCall" ? [block.id] : [])
		: [callId]);
	let end = at + 1;
	while (end < messages.length) {
		const next = messages[end]!;
		if (next.role !== "toolResult" || !siblings.has(next.toolCallId)) break;
		end++;
	}
	return end;
}

/** The teacher's history with the prober's prefix kept: the prober's leading system
 *  message, the record up to the handoff, the teacher's update, then the rest. Null
 *  when it cannot apply (no concluded probe, or an active compaction that cut past the
 *  handoff — that request has a new prefix anyway, so today's teacher request is used). */
export function sharedHandoffMessages(
	messages: readonly AgentMessage[],
	prober: AgentLoadout,
	teacher: AgentLoadout,
): AgentMessage[] | null {
	const record = messages as readonly LhMessage[];
	const at = handoffIndex(record);
	if (at === null) return null;
	// toLlmMessages renders an active compaction's summary in place of every
	// message before the first kept one: an update at or before that cut
	// would be dropped from the wire while its tools stay executable.
	const compaction = activeCompactionOf(record);
	if (compaction && keptIndexFor(record, compaction) >= at) return null;
	// Exactly what pi's Agent seeds for the prober (createMutableAgentState).
	const proberDeclarations = prober.tools.map(toToolDeclaration);
	const leading = createInitialSystemMessage(prober.systemPrompt, proberDeclarations);
	if (!leading) return null;
	const { toolsAdded, toolsRemoved } = getToolStateChanges(proberDeclarations, teacher.tools.map(toToolDeclaration));
	const anchor = record[at - 1]!;
	const update: SystemMessage = {
		role: "system",
		content: [HANDOFF_UPDATE_TEXT, teacher.systemPrompt].filter(Boolean).join("\n\n"),
		...(toolsAdded.length > 0 ? { toolsAdded } : {}),
		...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
		timestamp: anchor.timestamp,
	};
	return [leading, ...messages.slice(0, at), update, ...messages.slice(at)];
}
