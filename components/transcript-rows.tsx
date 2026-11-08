"use client";

/**
 * THE TRANSCRIPT ROWS (moved out of chat.tsx's render): one memoized row per
 * view message and one memoized part inside each assistant row. A streaming
 * update changes only the last row; the incremental projector
 * (src/core/view-incremental.ts) keeps every other row and part the same
 * object, and every prop below is either that object or a primitive derived
 * per row, so settled rows and parts skip rendering entirely. The rendered
 * output, keys and live-state rules are chat.tsx's, unchanged.
 */

import { Fragment, memo, useMemo } from "react";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { PathText } from "@/components/file-path-chip";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { LiveToolCard } from "@/components/artifacts/live-tool-card";
import { Separator } from "@/components/ui/separator";
import { AnsweredCard } from "@/components/answered-card";
import { MalformedQuestion } from "@/components/malformed-question";
import { artifactRenderers } from "@/components/artifacts";
import { SubagentSteerCard } from "@/components/artifacts/steer-card";
import { PlanBlock } from "@/components/plan-block";
import { ThinkingCard, type PracticeThinkingData } from "@/components/practice-cards";
import { GraphContextCard, type GraphContextData } from "@/components/graph-context-card";
import { PhaseDivider } from "@/components/phase-divider";
import { CompactionCutDivider, CompactionMomentDivider, type CompactionDividerData } from "@/components/compaction-divider";
import { ArrowRightIcon } from "lucide-react";
import {
	firstSourceTextParts,
	messageAnchorId,
	teachStepIndex,
	textPartMessageId,
	type ArtifactPartProps,
	type LhViewMessage,
	type LhViewPart,
	type Phase3,
	type PlanBlockData,
	type QuestionAnswerData,
	type QuestionCall,
} from "@/src/core";

/** The quiet system line (custom-message scheme rendering): centered, muted,
 *  small — the transcript's voice for events that are not speech (wake
 *  scaffolding). */
function SystemLine({ children, testId }: { children: React.ReactNode; testId?: string }) {
	return (
		<div
			data-testid={testId}
			className="flex items-center justify-center gap-1.5 py-1 text-xs text-muted-foreground"
		>
			{children}
		</div>
	);
}

/** A wake-pipeline steer message: user-role delivery whose metadata marks it
 * as a sub-agent result — rendered as an artifact card, never a bubble. */
function isSubagentSteer(m: LhViewMessage): boolean {
	return (m.metadata as { subagentResult?: unknown } | undefined)?.subagentResult != null;
}

const NO_MALFORMED: readonly QuestionCall[] = [];

export interface TranscriptRowsProps {
	messages: readonly LhViewMessage[];
	/** phaseTimeline(messages): the teach seam's divider. */
	phases: readonly Phase3[];
	/** The progressive fill (components/progressive-transcript.ts). */
	transcript: { hidesMessage: (mi: number) => boolean; hiddenParts: (mi: number) => number };
	/** status === "streaming": the last part's reasoning spinner. */
	streaming: boolean;
	/** The native message being written right now (while streaming): only ITS
	 *  reasoning shows "Thinking…". A hidden step (lesson tracking) projects no
	 *  part, and must not re-activate an earlier step's reasoning. */
	activeMessageId?: string;
	/** Malformed question calls; ignored while a turn runs. */
	malformedQuestions: readonly QuestionCall[];
	busy: boolean;
	/** A question owns the dock (a malformed retry must wait). */
	questionPending: boolean;
	compacting: boolean;
	onRetryQuestion: (call: QuestionCall) => void;
}

/** Each row's anchored text part ids (one DOM anchor per native teacher
 *  message, at its first non-empty prose block), as a primitive per row so
 *  a settled row's prop stays equal across updates. */
function rowAnchors(messages: readonly LhViewMessage[]): string[] {
	const first = firstSourceTextParts(messages);
	return messages.map((m) => {
		let anchors = "";
		for (const part of m.parts) {
			if (part.type !== "text" || !part.id) continue;
			const sourceId = textPartMessageId(part.id);
			if (sourceId && first.get(sourceId) === part.id) anchors += `${anchors ? "\n" : ""}${part.id}`;
		}
		return anchors;
	});
}

export function TranscriptRows({
	messages,
	phases,
	transcript,
	streaming,
	activeMessageId,
	malformedQuestions,
	busy,
	questionPending,
	compacting,
	onRetryQuestion,
}: TranscriptRowsProps) {
	const anchors = useMemo(() => rowAnchors(messages), [messages]);
	const malformed = busy ? NO_MALFORMED : malformedQuestions;
	return messages.map((m, mi) =>
		transcript.hidesMessage(mi) ? null : (
			<TranscriptRow
				key={m.id || `m-${mi}`}
				message={m}
				rowKey={m.id || `m-${mi}`}
				// THE INFERRED TEACH SEAM: the phase fold flips to teach exactly
				// AT this assistant group (see TranscriptRow).
				teachSeam={m.role === "assistant" && mi > 0 && phases[mi] === "teach" && phases[mi - 1] !== "teach"}
				hiddenParts={transcript.hiddenParts(mi)}
				streamingLast={streaming && mi === messages.length - 1}
				activeReasoningId={streaming && mi === messages.length - 1 && activeMessageId ? `${activeMessageId}-r0` : undefined}
				anchors={anchors[mi]!}
				malformedQuestions={malformed}
				questionPending={questionPending}
				compacting={compacting}
				onRetryQuestion={onRetryQuestion}
			/>
		),
	);
}

interface RowProps {
	message: LhViewMessage;
	rowKey: string;
	teachSeam: boolean;
	/** Leading parts still waiting for the progressive fill. */
	hiddenParts: number;
	/** The live turn streams and this is the last row. */
	streamingLast: boolean;
	/** The reasoning part id of the message being written now, when known. */
	activeReasoningId?: string;
	anchors: string;
	malformedQuestions: readonly QuestionCall[];
	questionPending: boolean;
	compacting: boolean;
	onRetryQuestion: (call: QuestionCall) => void;
}

const TranscriptRow = memo(function TranscriptRow({
	message: m,
	rowKey,
	teachSeam,
	hiddenParts,
	streamingLast,
	activeReasoningId,
	anchors,
	malformedQuestions,
	questionPending,
	compacting,
	onRetryQuestion,
}: RowProps) {
	const anchored = useMemo(() => new Set(anchors ? anchors.split("\n") : []), [anchors]);
	if (m.role === "user" && isSubagentSteer(m)) {
		// Sub-agent delivery (wake-pipeline steer): no message bubble; the
		// artifact card sits in the transcript column directly, full width
		// and centered like the teacher's artifacts (contracts.ts "THE ASYNC
		// PROTOCOL" §4). Legacy transcripts can hold empty ids, so keys fall
		// back to the index.
		return <SubagentSteerCard message={m} />;
	}
	if (m.role === "user" && m.parts.some((p) => p.type === "data-probe-handoff")) {
		// The probe→teach handoff wake renders as the Planning divider (the
		// marker sits in the right spot by record construction). Never a user
		// bubble: the wake is scaffolding; the model-facing instruction lives
		// in the adapter.
		return <PhaseDivider phase="plan" />;
	}
	if (m.role === "user" && m.parts.length > 0 && m.parts.every((p) => p.type.startsWith("data-"))) {
		// Marker cards: user-side scaffolding (the graph-context pick, the
		// practice thinking trace) renders as cards in the transcript column,
		// no chat bubble. The user branch below renders text only, so a
		// data-only message would otherwise show as an empty bubble.
		return (
			<>
				{m.parts.map((part, pi) => {
					switch (part.type) {
						case "data-graph-context":
							return <GraphContextCard key={pi} data={part.data as GraphContextData} />;
						case "data-compaction":
							return <CompactionMomentDivider key={pi} data={part.data as CompactionDividerData} />;
						case "data-compaction-cut":
							return <CompactionCutDivider key={pi} data={part.data as CompactionDividerData} />;
						case "data-practice-thinking":
							return <ThinkingCard key={pi} data={part.data as PracticeThinkingData} />;
						case "data-practice-next":
							// The learner's move-on signal: a compact centered mono-caps
							// line, in the dismissal register.
							return (
								<div
									key={pi}
									data-testid="practice-next-line"
									className="my-4 flex items-center justify-center gap-1.5 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground"
								>
									<ArrowRightIcon className="size-3" />
									Next problem
								</div>
							);
						default:
							return null;
					}
				})}
			</>
		);
	}
	// THE INFERRED TEACH SEAM: teaching begins where the first
	// nodeId-tagged quiz is posed; the fold (phaseTimeline, which the phase
	// chip also reads) flips to teach exactly at this assistant group. The
	// seam is step-level: the plan presentation often lives in the same
	// message, an earlier provider step than the quiz call, and must stay
	// above the divider. teachStepIndex finds the step boundary governing
	// the flip call: -1 = the message's first step → prepend before the
	// whole block; a later index → the divider renders at that part boundary
	// in the loop below (replacing the plain step hairline). The boundary
	// check (this index flips, the previous didn't) guarantees exactly one
	// divider per session. Prepended, never a replacement branch: the teach
	// group is a real message whose content must still render.
	const teachStep = teachSeam ? teachStepIndex(m.parts) : null;
	return (
		<Fragment>
			{teachStep === -1 ? <PhaseDivider key={`teach-${rowKey}`} phase="teach" /> : null}
			{m.role === "user" ? (
				/* THE DOCUMENT ROW: no right-aligned bubble; the transcript reads
				    as a document. User text is a full-width quote block: muted
				    "You" label, muted rail, full-opacity text (learner words are
				    content).
				    Distinguished from user thinking at a glance: thinking is
				    collapsed + 50% italic; this is upright and present.
				    User text renders plain — the model's LaTeX pipeline is not
				    applied to learner-authored text ($ stays $, no surprises).
				    Rendered WITHOUT the Message wrapper — that is the bubble. */
				<div
					data-testid="user-message"
					/* The user message is a full-width card-color band with the
					    same geometry as the thinking rows: 5px band
					    padding, the left gap matches it, the rail fills the 3ch
					    inset (the band is the authorship mark against the agent's
					    transparent prose). The "You" label stays — one register
					    with the thinking labels. */
					className="my-2 w-full border-l-[calc(3ch-14px)] border-muted-foreground/30 bg-card py-1 pl-[14px] pr-4 font-ui text-xs"
				>
					{/* The YOU heading sits inside the rail, in the same mono-xs
					    register and 1ch rail as the thinking rows. */}
					<div className="font-medium uppercase tracking-wide text-muted-foreground">You</div>
					<div className="lh-prose whitespace-pre-wrap text-foreground">
						<PathText text={m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")} />
					</div>
				</div>
			) : (
				<Message from="assistant" className="max-w-full">
					<MessageContent className="w-full">
						{m.parts.map((part, pi) => {
							if (pi < hiddenParts) return null;
							// The step boundary where teaching begins: when the teach
							// flip happens in a later step, its PhaseDivider replaces
							// this boundary's plain hairline.
							const teachBoundary = teachStep === pi;
							const isQuestion = QUESTION_PARTS.has(part.type);
							const malformed = isQuestion
								? malformedQuestions.find(
										(call) =>
											call.messageId === part.sourceMessageId &&
											call.contentIndex === part.sourceContentIndex &&
											call.toolCallId === part.toolCallId,
									)
								: undefined;
							return (
								<TranscriptPart
									key={partKey(part, pi, teachBoundary)}
									part={part}
									pi={pi}
									teachBoundary={teachBoundary}
									reasoningStreaming={streamingLast && pi === m.parts.length - 1 && (activeReasoningId === undefined || part.id === activeReasoningId)}
									textStreaming={streamingLast && pi === m.parts.length - 1}
									anchored={part.type === "text" && !!part.id && anchored.has(part.id)}
									malformed={malformed}
									questionPending={malformed ? questionPending : false}
									compacting={malformed ? compacting : false}
									onRetryQuestion={onRetryQuestion}
								/>
							);
						})}
					</MessageContent>
				</Message>
			)}
		</Fragment>
	);
});

const QUESTION_PARTS = new Set(["tool-quiz", "tool-probe", "tool-ask_user_question", "tool-explain", "tool-recall"]);

/** Each part element's key. Stable keys keep reconciliation, and with it
 *  every card's local state, intact. */
function partKey(part: LhViewPart, pi: number, teachBoundary: boolean): string | number {
	if (part.state === "output-error" && part.type.startsWith("tool-") && part.errorText !== "Operation aborted") return `retry-${pi}`;
	if (part.type === "text") return part.id || pi;
	if (part.type === "step-start" && teachBoundary) return `teach-step-${pi}`;
	return pi;
}

interface PartProps {
	part: LhViewPart;
	pi: number;
	teachBoundary: boolean;
	/** The live turn streams and this is the transcript's last part. */
	reasoningStreaming: boolean;
	/** This text part is still arriving (the live turn's last part). */
	textStreaming: boolean;
	/** This text part carries its native message's DOM anchor. */
	anchored: boolean;
	malformed: QuestionCall | undefined;
	questionPending: boolean;
	compacting: boolean;
	onRetryQuestion: (call: QuestionCall) => void;
}

const TranscriptPart = memo(function TranscriptPart({
	part,
	pi,
	teachBoundary,
	reasoningStreaming,
	textStreaming,
	anchored,
	malformed,
	questionPending,
	compacting,
	onRetryQuestion,
}: PartProps) {
	// A tool call that errored BACK TO THE AGENT (validation
	// failure, malformed args) is invisible work — the agent
	// reads the error and retries. Surface the retry loop as one
	// quiet line, any tool, so a flailing loop doesn't read as a
	// stall. Aborts are terminal (nothing retries), so they stay
	// silent.
	if (part.state === "output-error" && part.type.startsWith("tool-") && part.errorText !== "Operation aborted") {
		return <SystemLine testId="tool-retry">Retrying…</SystemLine>;
	}
	switch (part.type) {
		case "text": {
			const sourceId = textPartMessageId(part.id);
			const anchor = sourceId && anchored ? messageAnchorId(sourceId) : undefined;
			return (
				<div id={anchor} data-source-message-id={sourceId ?? undefined} className="lh-source-passage">
					<MessageResponse streaming={textStreaming}>{part.text}</MessageResponse>
				</div>
			);
		}
		case "reasoning":
			return (
				<Reasoning isStreaming={reasoningStreaming} className="mb-2">
					<ReasoningTrigger />
					<ReasoningContent>{part.text ?? ""}</ReasoningContent>
				</Reasoning>
			);
		case "step-start":
			if (teachBoundary) return <PhaseDivider phase="teach" />;
			return pi > 0 ? <Separator className="my-3" /> : null;
		case "data-plan-block":
			// The plan in the chat: a frozen snapshot block, rendered as
			// carried, never re-derived.
			return <PlanBlock data={part.data as PlanBlockData} />;
		case "tool-quiz":
		case "tool-probe":
		case "tool-ask_user_question":
		case "tool-explain":
		case "tool-recall": {
			if (malformed) return <MalformedQuestion disabled={questionPending || compacting}
				reason={questionPending ? "Answer or discard the remaining question first." : undefined}
				onRetry={() => onRetryQuestion(malformed)} />;
			// Pending/streaming questions live in the dock, not the
			// transcript; answered ones render as graded records.
			if (part.state === "output-available") {
				return <AnsweredCard answer={part.output as QuestionAnswerData} input={part.input} />;
			}
			return null;
		}
		default: {
			// A tool call being written: input-streaming spans the whole
			// execution, and the live card (spinner + shimmered activity label,
			// the input watchable on expand) shows it. On settling, the
			// registry's card takes over below.
			if (part.type.startsWith("tool-") && part.state === "input-streaming") {
				return <LiveToolCard part={part as ArtifactPartProps["part"]} />;
			}
			// Artifact extension point (contracts.ts): job
			// parts and future artifacts render via the
			// registry — add renderers there, not here.
			if (part.type.startsWith("tool-")) {
				const Renderer = artifactRenderers[part.type.slice("tool-".length)];
				if (Renderer) return <Renderer part={part as ArtifactPartProps["part"]} />;
			}
			return null;
		}
	}
});
