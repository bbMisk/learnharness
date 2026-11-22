/**
 * Chat-session contracts — records, summaries, UI extension points
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers. See docs/archive/vision.md.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { LearningEvent } from "../learning-history.ts";
import type { LhMessage } from "../native-messages.ts";
import type { Phase3 } from "../phases.ts";
import type { PlanNodeStatus, PlanTree } from "./plan.ts";
import type { EmissionStats } from "./graph.ts";

// ─── Chat records (the session store's on-disk format) ───────────────────────

/** Session kind: teach is the default when a saved record omits kind.
 * Practice uses the adaptive-practice agent without teaching extraction or
 * graph writes. Reading an absent kind does not require a record migration. */
export type ChatKind = "teach" | "practice";

/** One persisted session: data/chats/<id>.json. The stored messages are
 * pi-NATIVE history (LhMessage — the agent loop's own shapes,
 * provider/model/usage/thinkingSignature stamped by pi) — the canonical
 * session record IS the agent state; replay is
 * `state.messages = record.messages` + continue(). The client-shaped view
 * is the client's own grouping fold (core/view.ts) — a pending quiz is an
 * unanswered question tool call, which is exactly what makes
 * resume-mid-question free. */
export interface ChatRecord {
	pinned?: boolean;
	archived?: boolean;
	projectId?: string;
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: LhMessage[];
	/** Raw learning facts retained independently of transcript compaction. */
	learningEvents?: LearningEvent[];
	/** Session-local processed pictures; artifact records carry references only. */
	imageSnapshots?: Record<string, ImageSnapshot>;
	/** The session's kind; an absent field reads as teach. */
	kind?: ChatKind;
	/** Chosen after the probe: "cram" runs the test-focused loop
	 *  (core/cram.ts); absent = the full teaching method. */
	style?: "cram";
	/** The session's plan tree (vision §2) — written by plan tools via saveTree. */
	tree?: PlanTree;
	/** Append-only usage log: one entry per model turn. DELIBERATELY a parallel
	 * log, not per-message metadata — the client re-POSTs its message list
	 * every turn and its copies never carry server-stamped fields, so anything
	 * inside message objects gets clobbered by the next persist. Keyed by
	 * messageId so the transcript view can fold each entry onto its message;
	 * aggregates are folds over this log (core/prices.ts). */
	turns?: TurnUsage[];
	/** Append-only background-extraction usage for this chat, separate from
	 * messages. Finished runs include failed runs with usage; appends are
	 * idempotent by startedAt. */
	extractions?: ExtractionRunUsage[];
	/** Per-chat model/thinking overrides for the conversation agents. */
	settings?: ChatSettings;
	/** SCHEMA STAMP: LAZY v1 — existing records stay unstamped (absence reads
	 *  as v1); every write stamps the current version. A record stamped NEWER
	 *  than this build (the downgrade scenario) is REFUSED on read: a
	 *  read-modify-write store must never rewrite what it doesn't understand. */
	version?: number;
}

/** The chat record format this build writes and understands. */
export const CURRENT_CHAT_VERSION = 1;

/** The conversation agents' runtime model choice: a per-chat override for
 *  the prober/teacher (chat.model → the settings' strong slot; see
 *  core/settings-resolution.ts). Written by the model picker
 *  (PUT /api/chats/[id]/settings) and read at turn composition — the
 *  agents are stateless per turn, so a change takes effect on the next
 *  turn by construction. Background sub-agents are NEVER overridden
 *  (they're infrastructure, not conversation). */
export interface ChatSettings {
	/** Explicit provider-qualified model coordinates from the host catalog. */
	model?: { provider: string; id: string };
	/** pi thinking level — must be in the chosen model's supported list
	 *  (getSupportedThinkingLevels; enforced by the settings route). */
	thinkingLevel?: ThinkingLevel;
	/** The lesson's question type: the teacher's quizzing tools — "mcq"
	 *  multiple choice (quiz), "saq" short answer (explain), "mixed" both.
	 *  Written by the header's Qs chip; absent = cram lessons Mixed, other
	 *  lessons the app-wide Settings → Agent mechanic (core/question-type.ts
	 *  effectiveQuestionType). Teacher only: the prober and practice sessions
	 *  never read it. */
	questionType?: QuestionType;
}

/** The per-lesson question types. */
export type QuestionType = "mcq" | "saq" | "mixed";


// ─── Background-extraction usage (the money channel, extraction side) ────────

/** One pipeline stage's model usage — the stage's model + every step it
 *  billed (CallUsage per agent step). Steps, not a sum: cost and context
 *  folds happen at read time (core/prices.ts). */
export interface ExtractionStageUsage {
	/** The model that ran this stage, provider-qualified ("provider:id")
	 * for key-independent Pi catalog lookup at read time. */
	model: string;
	steps: CallUsage[];
}

/** One finished (or failed mid-flight) extraction run's usage record.
 *  Appended to the chat's `extractions` log when the run ends — success or
 *  failure, because money was spent either way; `stats` is present only
 *  when the merger actually ran. */
export interface ExtractionRunUsage {
	/** The run's registry startedAt (ms) — the idempotency key. */
	startedAt: number;
	at: string;
	durationMs: number;
	/** What the run merged into the graph; absent when it failed first. */
	stats?: EmissionStats;
	/** Model usage per stage, in pipeline order (merger is deterministic —
	 *  no model call, no entry). */
	stages: {
		extractor: ExtractionStageUsage;
		auditor: ExtractionStageUsage;
	};
}

// ─── Usage accounting (the money channel) ─────────────────────────────────────

/** One model call's token accounting — pi's per-step Usage flattened to
 * the fields we persist (undefined = provider didn't report;
 * renderers show absent, never zero). */
export interface CallUsage {
	/** Pi-normalized fresh input tokens; cache buckets are disjoint. */
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	/** Cached input tokens READ (billed at the cache-read rate, if any). */
	cacheReadTokens: number | undefined;
	/** Input tokens written to the cache this call; undefined when not reported. */
	cacheWriteTokens: number | undefined;
	/** Subset of cacheWriteTokens written with one-hour retention. Missing
	 * on older logs; new native captures explicitly record zero if absent. */
	cacheWrite1hTokens?: number;
	/** The reasoning portion of the output tokens. */
	reasoningTokens: number | undefined;
}

/** Usage for one native conversation-handler invocation, including user and
 * wake turns. A tool-using turn may span several separately billed model calls.
 * Accounting is captured when the turn persists; cost is estimated from the
 * recorded calls and model catalog at read time. */
export interface TurnUsage {
	/** Request identity for one handler invocation and the append-only log's
	 * idempotency key. Distinct from the transcript association in messageId. */
	id: string;
	/** The assistant message the turn produced — provenance, keys this
	 *  entry to the transcript (the block this turn "belongs" to). */
	messageId: string;
	at: string;
	/** The model that ran the turn, provider-qualified ("provider:id")
	 * for key-independent Pi catalog lookup at read time. */
	model: string;
	/** One entry per agent step (model call) in this turn. */
	steps: TurnStepUsage[];
}

/** Cache-miss diagnostics: a compact fingerprint of the request a conversation
 * step actually sent, so a mostly-missed prompt cache can be told apart from
 * the saved usage alone — the REQUEST changed (our fault) or the provider
 * missed (eviction/routing). Computed only where the final provider body is
 * observable (today: the ChatGPT adapter's prepared payload); absent elsewhere
 * and on records written before it existed. */
export interface RequestFingerprint {
	/** 12 hex of sha256 over the instructions/system prompt and the tool
	 *  definitions as sent. */
	promptHash: string;
	/** True when this request's history starts with the previous request's
	 *  full history for the same chat (same model and promptHash, earlier
	 *  input an exact prefix); false otherwise. Absent on the chat's first
	 *  fingerprinted call in this process. */
	extendsPrevious?: boolean;
}

/** One conversation step: its token accounting plus, when computable, the
 * request fingerprint. Both fields stay optional — old records load as-is. */
export interface TurnStepUsage extends CallUsage, Partial<RequestFingerprint> {}

// ─── Plan blocks (the plan lives in the chat) ────────────────────────────────

/** Payload of the persisted `data-plan-block` UI part (2026-09 design): a
 * SNAPSHOT of the plan at the moment it changed, rendered as a block in the
 * chat flow. Attached to the assistant message that carries the plan_init
 * tool call (kind "full") or the answered check quiz part (kind
 * "neighborhood"). Data parts never reach the model (convertToModelMessages
 * drops them) — the block is pure UI history, reappearing identically on
 * reload because it lives in the record.
 *
 * Rendering contract: a "full" block renders the whole DAG borderless,
 * horizontally filling the chat column, natural height; a "neighborhood"
 * block renders current node + direct parents + direct children in its own
 * small container, the current node glowing — clearly a fragment, not the
 * whole plan. Clicking either opens the full plan in a popup. */

/** The model-facing text of the probe→teach handoff wake (the custom-message
 *  scheme): the wake message carries only the data-probe-handoff part, and
 *  the adapter flattens it to THIS. Single-sourced so the prober's seam, the
 *  tests, and reality can't drift apart.
 *
 *  REASONING-FIRST PACING (owner, 2026-09-26): the wake is the one per-turn
 *  cue on the launch turn — the old one-liner read as a dispatch order
 *  ("author now") and the teacher skipped the deliberation the planning
 *  fragment asks for. So the wake paces it: reason out the optimal way to
 *  teach THIS person THIS thing BEFORE plan_init. Honest to the machinery
 *  — plan_init is still the first tool, the plan map still the first
 *  artifact, and presenting still ends the turn (the verdict death,
 *  2026-09-26: the learner's next message is a natural reply — a change
 *  request or the go-ahead). */
export const HANDOFF_TEXT =
	"Next: plan the full teaching arc from my current understanding to the goal understanding. " +
	"Apply the teaching methodology in your system prompt, and find the optimal way to teach me this. " +
	"Find the unconditional truths, plan the motivated derivations/discoveries, so every reasoning step has to land as obviously true. " +
	"Take your time here and really think this through. " +
	"When it's genuinely reasoned out, call plan_init and present the plan; I'll accept it or ask for changes.";

// ─── Practice sessions (owner, 2026-10-04) — marker + ack texts ──────────────
// Single-sourced here per the marker law: the model-facing text of every
// custom marker lives in core/contracts, never in the flattening seam.

/** The model-facing register of a thinking submission (newThinkingMessage
 *  prefixes the learner's text with this label). Hints and commits ride
 *  one channel — the label is the ONLY difference the model sees. */
/** The single submission label (owner round, 2026-10-05): one send
 *  lane — whether a submission claims an answer is read from the text,
 *  not declared by a button. */
export const THINKING_LABEL = "Your thinking";

/** The conclude tool's ack — shared by the executed call (agent layer) and
 *  the dismissal-synthesized pair (input-events), so a concluded problem
 *  reads identically to the model however it concluded. Owner round 16:
 *  the turn ENDS after concluding (a system-prompt law, no tool-level
 *  terminate — the model may speak its closing words first, then must
 *  stop calling tools); the next problem waits for the learner's
 *  explicit go-ahead. */
export const CONCLUDE_ACK_TEXT =
	"Problem concluded. Say your closing words about the learner's work if useful, then END YOUR TURN — no further tool calls. The next problem is NEVER posed here: it waits for the learner's explicit go-ahead (a *Next problem* message, or their own words asking for the next one). Between problems, answer their questions about the concluded one.";

/** The learner's explicit move-on signal (owner round 16, 2026-10-06):
 *  the model-facing text of the practice-next marker — single-sourced
 *  like THINKING_LABEL. The button/Enter-on-empty path appends the
 *  marker; the model reads this and poses (or wraps) per the doctrine. */
export const NEXT_PROBLEM_TEXT =
	"[NEXT PROBLEM] — the learner's explicit go-ahead: pose the next problem now per the selection rules, or wrap the session in text if the arc is complete.";

/** The compaction marker's model-facing header (owner round 14,
 *  2026-10-05). The marker's content is this header + the summary — the
 *  single text the provider sees in place of the dropped span. Wording
 *  law: it must tell the model (a) a cut happened and is routine, (b) the
 *  summary replaces everything before it, (c) what follows is verbatim
 *  recent transcript — so the model neither re-asks covered ground nor
 *  distrusts the seam. */
export const COMPACTED_HISTORY_HEADER =
	"[SESSION HISTORY COMPACTED] The transcript before this point was summarized to fit the context window; the summary below replaces it. Everything after this message is the verbatim recent transcript.";


export interface PlanBlockData {
	/** Only "full" survives (the 2026-09-11 pivot): the plan renders IN
	 *  FLOW once, at authoring. The neighborhood fragments are retired —
	 *  position derives live from the transcript (the persistent DAG
	 *  window is the successor). */
	kind: "full";
	at: string;
	/** The current node at snapshot time (the glow target; null = none). */
	current: string | null;
	/** All nodes of the authored tree. Statuses are the snapshot's,
	 * derived at emission time — the block never re-derives at render. */
	nodes: Array<{ id: string; title: string; status: PlanNodeStatus }>;
	edges: Array<{ from: string; to: string }>;
}

/** Saved-session summary with a message count instead of full history.
 * Phase and pending-input flags derive from native transcript events.
 * Live turn/compaction state is added separately in ChatListItem, not
 * inferred from the saved record. */
export interface ChatSummary {
	pinned?: boolean;
	archived?: boolean;
	projectId?: string;
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	/** Normalized kind (absent record field reads as teach). */
	kind: ChatKind;
	messageCount: number;
	/** Transcript-derived phase: probe ends at successful probe_done completion;
	 * plan ends at the first node-tagged teaching question call, not its answer. */
	phase: Phase3;
	/** An unanswered quiz/ask question is waiting for the learner. */
	pendingQuestion: boolean;
	/** A practice problem is posed but not concluded. False on teaching sessions. */
	pendingProblem: boolean;
	/** Cumulative sidebar time in ms, including the pre-tracking estimate. */
	timeSpentMs?: number;
	measuredStudyMs?: number;
	estimatedStudyMs?: number;
	/** The record's model-control settings — rides the list payload via the
	 *  summary spread (the picker never needs it from here; the full record
	 *  is its source). */
	settings?: ChatSettings;
}

/** Session-list row combining a saved summary with live server state.
 * busy means a native conversation turn is in flight; detached background
 * jobs do not make the session busy. These flags are not persisted status. */
export interface ChatListItem extends ChatSummary {
	busy: boolean;
	/** True while background context compaction holds the chat's model gate.
	 * Supplied by the live compaction registry, not by saved compaction markers. */
	compacting: boolean;
}

// ─── Learner images in the lesson (issue #363) ──────────────────────────────

/** One upright, metadata-free picture, stored once per session. */
export interface ImageSnapshot {
	mimeType: "image/png" | "image/jpeg";
	data: string;
	width: number;
	height: number;
}

/** The show_image record payload. Its session-owned snapshot is never model-facing. */
export interface ShowImageDetails {
	/** The absolute path the image was read from. */
	path: string;
	caption?: string;
	mimeType: "image/png" | "image/jpeg";
	/** SHA-256 identity in ChatRecord.imageSnapshots. */
	snapshotId: string;
	width: number;
	height: number;
}

// ─── Artifact renderer registry (client extension point) ────────────────────

/**
 * components/chat.tsx renders any tool part it doesn't specially handle via
 * components/artifacts/index.ts's registry, keyed by tool name ("research",
 * "demo", "visual", …). Workers add renderers there — chat.tsx is off-limits
 * to artifact work. Renderer receives the raw tool part; it typically renders
 * an activity card while state is input-available (poll /api/jobs) and the
 * artifact (iframe / svg) when output-available.
 */
export interface ArtifactPartProps {
	part: {
		type: string;
		state: string;
		toolCallId: string;
		input?: unknown;
		output?: unknown;
		/** The pose-side fold (owner round 17): the whole problem-call
		 * arguments joined onto the conclude part by projectView — the
		 * observability drawer's data. */
		problemInput?: unknown;
		/** The view-seam join for conclude cards (owner round, 2026-10-05):
		 *  the modelSolution committed at POSE time, folded onto the part by
		 *  projectView — the reveal is never re-authored. */
		reveal?: unknown;
	};
}
