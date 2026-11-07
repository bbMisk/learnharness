"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChatSession } from "@/components/session";
import { visibleQueuedSteers } from "@/components/session-core";
import { SetupDialog } from "@/components/setup-dialog-lazy";
import { ChatActionsContext } from "@/components/chat-actions";
import { Hint } from "@/components/ui/hint";
import { useModelSetup, selectedModelUnavailable, openModelPicker, ZeroKeysPill } from "@/components/setup-cta";
import type { StickToBottomContext } from "use-stick-to-bottom";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
} from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrailleSpinner } from "@/components/braille-spinner";
import { TranscriptRows } from "@/components/transcript-rows";
import { ChatSessionComposer } from "@/components/composer";
import { useEnterSubmits } from "@/components/enter-submits";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { clearOpeningPrompt, readOpeningPromptEntry, stashOpeningPrompt, OPENING_PROMPT_FAILURE } from "@/components/opening-prompt";
import { SessionStarter, startWeakSpotsPractice } from "@/components/start-session";
import { useRouter } from "next/navigation";
import { DictationBar, joinDictation, useDictation } from "@/components/dictation";
import { useFieldCycle } from "@/components/field-cycle";
import { JobsContext } from "@/components/jobs-context";
import { useServerEvent, useServerResync } from "@/components/server-events";
import {
	isProviderKeyRefusal,
	cliContextWindowOf,
	kbdEventForAction as kbdEventForChat,
	type ChatInput,
	type EnabledTools,
	type LhMessage,
	type QuestionType,
	type ModelSlotName,
} from "@/src/core";
import { PlanPopup, latestTree } from "@/components/plan-block";
import { PlanMarginalia, planExists } from "@/components/plan-window";
import { MermaidOverlay, SessionMermaidContext } from "@/components/session-overlay";
import { AbortTurnDialog, type AbortMode } from "@/components/abort-turn-dialog";
import { DumbbellIcon, MessageCircleQuestionIcon, WaypointsIcon } from "lucide-react";
import { SessionFind } from "@/components/session-find";
import { SessionMessageNavigation } from "@/components/session-navigation";
import { useProgressiveTranscript } from "@/components/progressive-transcript";
import { TopBar } from "@/components/top-bar";
import type { JobRecord, QuestionCall, TurnUsage, SessionPricing } from "@/src/core";
import { PhaseChip } from "@/components/phase-divider";
import { CramToggle, useLessonCram } from "@/components/cram-toggle";
import { PLAN_ACCEPT_TEXT, PlanAcceptBar, awaitingPlanReply, offersPlanAccept } from "@/components/plan-accept";
import { recordSyncVerdict } from "@/components/record-sync";
import { QuestionTypeChip, showsQuestionTypeChip, useLessonQuestionType } from "@/components/question-type-chip";
import { LessonTrackerCard, LessonTrackerChip, lessonTrackerRoom, useLessonTrackerShown } from "@/components/lesson-tracker";
import { PinnedVisualContext, usePinnedVisual } from "@/components/pinned-visual";
import { CoverageRing } from "@/components/extraction-coverage";
import { Button } from "@/components/ui/button";
import {
	activeProblemOf,
	pendingQuestionOf,
	malformedQuestionsOf,
	dismissedAnswer,
	endsInFailedTurn,
	findPendingToolCall,
	phaseAt3,
	phaseTimeline,
	toolQuestionKind,
	isTeachingCheck,
	revealsQuestions,
	hasLessonTracking,
	lessonPlanProgress,
} from "@/src/core";
import { useGeneralSettings } from "@/components/general-settings";
import { readDraft, writeDraft } from "@/components/draft-store";
import { SideTutor, useSideTutor } from "@/components/side-tutor";
import { useReadingThinkingResync } from "@/components/reading-thinking-resync";
import { currentUserThinkingOpen, setAllUserThinkingOpen } from "@/components/thinking-block";
import { FACTORY_SETTINGS } from "@/src/core";
import { useReadingThinkingRefresh } from "@/components/reading-thinking-refresh";
import { DockOverlay, GRADIENT_H } from "@/components/dock-overlay";
import { useSessionRename } from "@/components/session-rename";

/** One width for everything: transcript, cards, and the bottom blob share this column. */
/**
 * Width tokens (wave-5 reskin, owner decision): the teaching PROSE spans the
 * full session width with a thin px-6 margin; the composer/question DOCK is
 * deliberately narrower (~46rem centered) per the reference. Same ELEMENT,
 * same place — width polish only.
 */
const COLUMN = "mx-auto w-full max-w-none px-6";

/** The BYOK refusal envelope from the transport's error text: the
 *  DefaultChatTransport throws the 503 body VERBATIM as the error message,
 *  so the machine-readable {code, missing} shape survives to here. Real
 *  errors (any other text) read as null and keep the honest banner.
 *  Exported pure for tests. */
export function parseModelsRefusal(message: string | undefined): ModelSlotName[] | null {
	if (!message) return null;
	try {
		const body = JSON.parse(message) as { code?: unknown; missing?: unknown };
		if (body.code === "models_not_configured" && Array.isArray(body.missing)
			&& body.missing.every((s) => typeof s === "string")) {
			return body.missing as ModelSlotName[];
		}
		return null;
	} catch {
		return null;
	}
}

/** The provider-key refusal's transport seam (zero-keys wave, Platform's
 *  66dbea9): same discipline as parseModelsRefusal — the 503 body rides
 *  the thrown error message verbatim, so the envelope's own matcher
 *  (core, invariant-tail) decides; the wording can never drift client-
 *  side. Exported pure for tests. */
export function parseProviderKeyRefusal(message: string | undefined): boolean {
	if (!message) return false;
	try {
		const body = JSON.parse(message) as { code?: unknown; error?: unknown };
		return body.code === "provider_key_missing" && typeof body.error === "string" && isProviderKeyRefusal(body.error);
	} catch {
		return false;
	}
}

/** Retry sends no composer text. Its refusal must not resurrect the draft
 * from an earlier, already-durable text send over today's unsent composer.
 * Retire that fallback synchronously, never when the async Retry settles:
 * a later ordinary send may own a new recovery draft by then. */
export function retryFailedResponse(
	send: (input: ChatInput) => void,
	submittedDraft: { current: string | null },
): void {
	submittedDraft.current = null;
	void send({ type: "retry" });
}

/** Keep a rejected prompt even when the learner has already started another draft. */
export function restoreInterruptedDraft(current: string, rejected: string): string {
	return current ? `${current}\n\n${rejected}` : rejected;
}

/**
 * The teaching session. All chat state lives in useChat; the server persists
 * the canonical transcript after every turn.
 *
 * The bottom blob is ONE persistent shell whose contents swap (chat composer ↔
 * question dock ↔ collapsed bar). The shell is sticky INSIDE the scroller —
 * never overlapping the transcript at rest, never covering the scrollbar —
 * and DockOverlay animates its height on variant changes.
 */
export function Chat({
	chatId,
	title,
	initialMessages,
	initialError,
	initialPrompt,
	initiallyInFlight,
	initiallyCompacting = false,
	initialConfigured = false,
	initialShowReadingThinking = FACTORY_SETTINGS.general.showReadingThinking,
	kind = "teach",
	style,
	projectId,
	questionType: initialQuestionType,
	agentTools,
}: {
	chatId: string;
	title: string;
	initialMessages: LhMessage[];
	/** Memory-only settlement notice supplied on reopening. */
	initialError?: string;
	/** The session kind (practice sessions, owner 2026-10-04): practice
	 *  renders no phase chip (no probe→teach arc applies) and a Practice
	 *  tag rides the header instead. */
	kind?: "teach" | "practice";
	/** "cram" for a lesson started in cram mode (core/cram.ts). */
	style?: "cram";
	/** The session's project (its "Practice weak spots" session joins it). */
	projectId?: string;
	/** The chat's stored question type (core/question-type.ts; absent = unset). */
	questionType?: QuestionType;
	/** Settings → Agent's tool map — an unset question type's app default. */
	agentTools?: EnabledTools;
	initialPrompt?: string;
	/** A teacher turn is running server-side but attached to no client
	 * (navigated away mid-turn, returned while in flight). */
	initiallyInFlight?: boolean;
	/** A compaction holds the chat's model gate at mount (navigated away
	 * mid-compaction — the registry is live server state, the
	 * compaction-changed event already fired). The transcript spinner
	 * and send gates key on it. */
	initiallyCompacting?: boolean;
	/** slotsConfigured(server record) — the persistent setup CTA keys on
	 *  it (BYOK, owner 2026-09-22). The server gate stays the truth; this
	 *  only decides whether the pill rides the composer. */
	initialConfigured?: boolean;
	initialShowReadingThinking?: boolean;
}) {
	// Reattach plumbing (background-turn runner wave): the hook holds the
	// settled terminal's callback — a stable ref assigned below, once
	// syncFromServer exists (refs, not closures: no stale capture).
	const reattachSettledRef = useRef<() => void>(() => {});

	// THE SESSION HOOK (Wave D, owner-approved 2026-09-26): the app-owned
	// replacement for useChat + the AI-SDK transport. The record is native
	// history; the VIEW (grouped, golden-master) is derived client-side
	// (core/view.ts projectView); sends are ONE explicit input event each
	// ({chatId, input} — the stash indirection died with the SDK), and the
	// turn stream is the VERBATIM AgentEvent passthrough the server emits.
	const { messages, nativeMessages, hasConfirmedConversation, contextTokens, lessonTracking: tracking, tutorPin, send, continueIfOwed, steer, steerQueue, submitAnswer, dismissQuestion, dismissProblem, questionDraft, saveQuestionDraft, setMessages, adoptRecord, status, error, abortTurn, clearError, resumeStream, setReattachSettled } =
		useChatSession({ chatId, initialMessages, initialError, initiallyInFlight });

	const sessionFindScopeRef = useRef<HTMLDivElement | null>(null);
	const scrollContextRef = useRef<StickToBottomContext | null>(null);

	// The reattach settled terminal → the sync-and-continue seam (below).
	setReattachSettled(() => reattachSettledRef.current());

	// A turn running server-side, attached to no live view of ours (navigate
	// away mid-turn, or a wake turn discovered mid-session): the reattach
	// stream is the primary channel (resumeStream — the same rendering path
	// as a live turn); this flag is the FALLBACK liveness source — it gates
	// the composer, shows the pre-first-chunk shimmer, and drives the 1500ms
	// record poll that adopts at settle if the stream can't attach.
	const [turnInFlight, setTurnInFlight] = useState(initiallyInFlight ?? false);

	const { titleText, renaming, setRenaming, titleDraft, setTitleDraft, titleInputRef, commitRename } = useSessionRename(chatId, title);

	// Explicit Stop shares the pending-send fence with composer interruptions.
	const abortInFlightTurn = useCallback(() => { void abortTurn(); }, [abortTurn]);
	// ESC-abort guard (owner, 2026-10-02): the abort chain opens a confirm
	// popup EVERYWHERE (streams and pending questions alike). Both window
	// listeners fire per Esc, so the state gate here — not stopPropagation
	// ordering — is what keeps the popup's own Esc from chaining.
	// LAYERED ESC (owner, 2026-10-04): an open overlay CLAIMS Esc — closing
	// itself — before the abort chain may open its confirm. A mermaid focus,
	// the plan popup, or the setup dialog over a pending question must not
	// dismiss the question underneath.
	const [abortAsk, setAbortAsk] = useState<AbortMode | null>(null);
	const abortAskRef = useRef<AbortMode | null>(null);
	abortAskRef.current = abortAsk;
	// The pinned demo/diagram's Esc inputs (assigned once the pin hook runs, below).
	const pinEscRef = useRef<ReturnType<typeof usePinnedVisual> | null>(null);
	useEffect(() => {
		const onAbort = () => {
			const pinned = pinEscRef.current;
			const target = escAbortTarget({
				abortAsk: abortAskRef.current !== null,
				mermaidFocus: mermaidFocusRef.current !== null || figureFocusRef.current !== null,
				pinExpanded: pinned?.escState.pinExpanded ?? false,
				drawer: pinned?.escState.drawer ?? null,
				planOpen: planOpenRef.current,
				setupOpen: setupOpenRef.current,
				pending: pendingRef.current !== null,
				problem: activeProblemRef.current !== null,
				busy: busyRef.current,
			});
			if (target === "question") setAbortAsk("question");
			else if (target === "problem") setAbortAsk("problem");
			else if (target === "turn") setAbortAsk("turn");
			else if (target === "mermaid") setMermaidFocus(null);
			else if (target === "plan") setPlanOpen(false);
			else if (target === "pin-expanded") pinned?.closeExpanded();
			else if (target === "pin-drawer") pinned?.toggleDrawer();
			// setup closes itself; null = nothing to do — both claimed.
		};
		window.addEventListener("lh:kbd-abort-turn", onAbort);
		return () => window.removeEventListener("lh:kbd-abort-turn", onAbort);
	}, []);
	const confirmAbort = useCallback(
		(mode: AbortMode) => {
			setAbortAsk(null);
			if (mode === "turn") {
				abortInFlightTurn();
				return;
			}
			// From a pending question the dismiss is silent (A2, 2026-10-03):
			// the skipped toolResult lands via the SILENT route, no turn, no
			// wake — the next plain send is the wake. MID-TURN (owner,
			// 2026-10-04 — the GLM loop): the question can only dangle because a
			// turn is STILL RUNNING, so the discard ALSO kills that turn; the
			// route parks the dismissal (202) and the settle applies it.
			const p = pendingRef.current;
			if (p) {
				const question = (p.input as { question?: string } | null)?.question ?? "";
				const reading = readingThinkingRef.current.trim() || undefined;
				clearReadingThinking();
				const answer = dismissedAnswer(toolQuestionKind(p.tool), question);
				void dismissQuestion(
					p.toolCallId,
					reading ? { ...answer, readingThinking: reading } : answer,
					p.key,
				);
				if (busyRef.current) abortInFlightTurn();
				return;
			}
			// The practice discard (owner, 2026-10-04): ask-style — the
			// silent marker route; the conclude synthesis rides the user's
			// next input. The composer returns immediately. Mid-turn the
			// discard also kills the running turn (same park + settle law).
			const problem = activeProblemRef.current;
			if (problem) {
				void dismissProblem(problem.toolCallId);
				if (busyRef.current) abortInFlightTurn();
			}
		},
		[abortInFlightTurn, dismissQuestion, dismissProblem],
	);
	// Mount continuation: if the stored transcript ends with a fulfilled tool
	// (a job result landed while no client was open), resume the lesson — the
	// SDK's sendAutomaticallyWhen only fires inside addToolOutput, so reloads
	// need this nudge. Once per mount; the turn that follows ends in text (or
	// a pending question), so no loop. NEVER while a turn is already running
	// server-side — that would double-run the teacher (the server would 409
	// it; the poll below resumes instead).
	const mountContinuation = useRef(false);
	useEffect(() => {
		if (mountContinuation.current) return;
		mountContinuation.current = true;
		if (!turnInFlight) continueIfOwed(initialMessages);
		// mount-only by design (turnInFlight read at initial value)
	}, []);

	const pending = findPendingToolCall(messages, pendingQuestionOf(nativeMessages));
	const malformedQuestions = useMemo(() => malformedQuestionsOf(nativeMessages), [nativeMessages]);
	// The abort handler reads the pending question from a ref (the window
	// listener is mount-scoped; the value it needs is render-scoped).
	const pendingRef = useRef(pending);
	pendingRef.current = pending;

	// THE ACTIVE PRACTICE PROBLEM (practice sessions, 2026-10-04): the
	// same dock-ownership rule as a pending question — an active problem
	// replaces the composer. Computed from the NATIVE record (the fold is
	// the gate the tools themselves read), not the projected view.
	const activeProblem = activeProblemOf(nativeMessages);
	const activeProblemRef = useRef(activeProblem);
	activeProblemRef.current = activeProblem;

	const localStream = status === "submitted" || status === "streaming";
	const busy = localStream || turnInFlight;
	const busyRef = useRef(busy);
	busyRef.current = busy;
	// The full record refresh's freshness snapshot (record-sync.ts).
	const nativeMessagesRef = useRef(nativeMessages);
	nativeMessagesRef.current = nativeMessages;
	// The attach handoff (stream-reattach wave): the moment a resumed
	// stream takes over the rendering — the SDK left "ready", so
	// submitted/streaming means chunks are flowing — localStream covers
	// busy/shimmer/gates on its own. Keeping turnInFlight set would only
	// double-render the shimmer and keep the 1500ms fallback poll fighting
	// the live stream it was a fallback FOR.
	useEffect(() => {
		if (turnInFlight && (status === "submitted" || status === "streaming")) setTurnInFlight(false);
	}, [status, turnInFlight]);

	// Mid-session discovery (jobs poll, handoff watch): a server-side turn
	// exists that none of our views holds — attach to it through the same
	// resume path as mount reattach (live rendering, instant catch-up). The
	// flag stays as the fallback until the stream attaches (watcher above);
	// concurrent resume calls are SDK-guarded (a newer one aborts the older
	// request), so discovery ticks re-firing this are harmless.
	const turnInFlightRef = useRef(turnInFlight);
	turnInFlightRef.current = turnInFlight;
	const attachToRunningTurn = useCallback(() => {
		setTurnInFlight(true);
		void resumeStream();
	}, [resumeStream]);

	// The practice dock's send (ONE lane, owner 2026-10-05): POSTs the
	// thinking against the ACTIVE problem — whether it claims an answer is
	// read from the text by the agent, not declared here. Starts a turn;
	// the dock stays mounted (the problem is still active until the agent
	// concludes).
	const submitThinking = useCallback(
		(text: string) => {
			const problem = activeProblemRef.current;
			if (!problem) return;
			void send({ type: "thinking", problemCallId: problem.toolCallId, text });
		},
		[send],
	);

	// A teach-phase check (quiz or explain, not a prediction; probe, plan
	// and ask questions never) keeps the optional reading-notes field. It
	// also waits behind the "Check your understanding" reveal, opened with
	// Enter or a click, when Settings → General → Reveal questions says so:
	// in cram mode by default (owner, 2026-11-01), always, or never. The
	// session's current phase IS the pending question's phase (the
	// teacher's turn ends at the question call).
	const teachingCheck = pending !== null && isTeachingCheck(pending.tool, pending.input, phaseAt3(messages));
	// Cram is chat metadata another window can switch: re-read on
	// chats-changed and reconnects, newest confirmed value first.
	const { cram, begin: beginCramSave } = useLessonCram(chatId, style === "cram");
	// The lesson's stored question type (owner, 2026-11-03): the Qs chip
	// writes it; record-changed and reconnects re-read it (another device's
	// pick), newest confirmed value first.
	const lessonQuestionType = useLessonQuestionType(chatId, initialQuestionType);
	// Hooks run on every render: never behind && (a skipped hook crashed the page after an answer).
	const revealSetting = useGeneralSettings()?.revealQuestions;
	const requiresReveal = teachingCheck && revealsQuestions(revealSetting, cram);

	/* The READING-THINKING channel (owner 2026-10-03): a draft field for
	 * thinking while reading the teaching prose, mounted while a check waits
	 * behind its reveal, riding the check answer (or its dismissal) as the
	 * separate `readingThinking` field. Reset per pending question. */
	const [showReadingThinking, setShowReadingThinking] = useState(initialShowReadingThinking);
	const [readingThinkingSeed, setReadingThinkingSeed] = useState({ questionId: null as string | null, value: "", revision: 0 });
	const readingThinkingRef = useRef("");
	useReadingThinkingResync(showReadingThinking, readingThinkingRef, setReadingThinkingSeed);
	const { sideTutor, toggleSideTutor, closeSideTutor } = useSideTutor();

	// ⌘T (toggle-user-thinking, owner round 2026-10-07): set EVERY user
	// thinking row to one state — transcript rows default open, so the
	// first press collapses everything, the second re-expands.
	useEffect(() => {
		const onToggle = () => setAllUserThinkingOpen(!currentUserThinkingOpen());
		window.addEventListener(kbdEventForChat("toggle-user-thinking"), onToggle);
		return () => window.removeEventListener(kbdEventForChat("toggle-user-thinking"), onToggle);
	}, []);
	const pendingKeyRef = useRef<string | null>(null);
	pendingKeyRef.current = pending?.key ?? null;
	const applyReadingThinking = useCallback((v: string) => {
		readingThinkingRef.current = v;
		if (pendingKeyRef.current) saveQuestionDraft(pendingKeyRef.current, { readingThinking: v });
	}, [saveQuestionDraft]);
	const clearReadingThinking = useCallback(() => {
		readingThinkingRef.current = "";
		setReadingThinkingSeed((previous) => ({ ...previous, value: "", revision: previous.revision + 1 }));
	}, []);
	const pendingQuestionId = pending?.key ?? null;
	useLayoutEffect(() => {
		// Different calls never share a draft; a failed submission of THIS
		// call restores the reading channel alongside the form's snapshot.
		const value = pendingQuestionId ? questionDraft(pendingQuestionId)?.readingThinking ?? "" : "";
		readingThinkingRef.current = value;
		setReadingThinkingSeed((previous) =>
			previous.questionId === pendingQuestionId && previous.value === value
				? previous
				: { questionId: pendingQuestionId, value, revision: previous.revision + 1 },
		);
	}, [pendingQuestionId, questionDraft]);

	// The phase at every message (one linear fold): the transcript draws a
	// color-coded dotted divider at each boundary; the header chip reads the
	// session's current phase.
	const phases = useMemo(() => phaseTimeline(messages), [messages]);
	const transcript = useProgressiveTranscript(messages);

	const [composerDraftRevision, setComposerDraftRevision] = useState(0);
	/* The composer draft ref is synchronous, so sends and dictation flushes
	 * read the latest text without a parent render per input event. Explicit
	 * resets still bump a revision so the local field can sync. */
	// The composer draft autosaves per chat (components/draft-store.ts).
	const textRef = useRef("");
	const composerDraftKey = `c:${chatId}`;
	useLayoutEffect(() => {
		const saved = readDraft<string>(composerDraftKey);
		if (saved && !textRef.current) {
			textRef.current = saved;
			setComposerDraftRevision((revision) => revision + 1);
		}
	}, [composerDraftKey]);
	const applyText = useCallback((v: string) => {
		textRef.current = v;
		writeDraft(composerDraftKey, v);
		setComposerDraftRevision((revision) => revision + 1);
	}, [composerDraftKey]);
	const recordComposerText = useCallback((v: string) => {
		textRef.current = v;
		writeDraft(composerDraftKey, v);
	}, [composerDraftKey]);
	// Saved slot completeness is live, but the session's selected route
	// comes from its own ordinary model control, never today's Strong pin.
	const { catalog, configured, zeroKeys } = useModelSetup(initialConfigured);
	const catalogRef = useRef(catalog);
	catalogRef.current = catalog;
	const [selectedModel, setSelectedModel] = useState<string | undefined>();
	const settingsRefreshError = useReadingThinkingRefresh(setShowReadingThinking);
	const [setupOpen, setSetupOpen] = useState(false);
	/** The last explicitly-sent draft (composer send): the
	 *  refusal flow restores it into the composer, where it waits for the
	 *  learner to re-send (Save never auto-sends, owner 2026-10-09).
	 *  Auto-continuations (probe answers) never set it — their refusal
	 *  opens recovery with no replay. */
	const draftRef = useRef<string | null>(null);
	const openingDraftRef = useRef<string | null>(null);
	const [openingError, setOpeningError] = useState(false);
	const openingMountedRef = useRef(false);
	useEffect(() => {
		openingMountedRef.current = true;
		return () => { openingMountedRef.current = false; };
	}, []);

	const deliverOpeningPrompt = useCallback((prompt: string) => {
		openingDraftRef.current = prompt;
		// Persist uncertainty BEFORE the POST: another mount must restore,
		// not race the still-arriving request. No storage means no auto-send.
		if (!stashOpeningPrompt(chatId, prompt, true)) {
			applyText(prompt);
			setOpeningError(true);
			return;
		}
		setOpeningError(false);
		draftRef.current = prompt; // The existing 503 flow must restore it too.
		applyText("");
		void send({ type: "text", text: prompt }, () => {
			clearOpeningPrompt(chatId);
			openingDraftRef.current = null;
			if (draftRef.current === prompt) draftRef.current = null;
		}).then(accepted => {
			if (!accepted && openingMountedRef.current && openingDraftRef.current === prompt && !textRef.current) {
				applyText(prompt);
			}
		});
	}, [chatId, send, applyText]);

	const sentInitial = useRef(false);
	useEffect(() => {
		if (sentInitial.current) return;
		sentInitial.current = true;
		const entry = readOpeningPromptEntry(chatId);
		const prompt = initialPrompt || entry?.text; // Legacy links still work.
		if (!initialPromptOwed(initialMessages, prompt)) {
			if (initialMessages.some(m => m.role === "user" || m.role === "assistant")) clearOpeningPrompt(chatId);
			return;
		}
		openingDraftRef.current = prompt!;
		if (entry?.attempted || initiallyInFlight) {
			applyText(prompt!); // Interrupted start: the learner explicitly resends.
			return;
		}
		deliverOpeningPrompt(prompt!);
	}, [chatId, initialPrompt, initialMessages, initiallyInFlight, deliverOpeningPrompt, applyText]);

	useEffect(() => {
		if (!hasConfirmedConversation) return;
		clearOpeningPrompt(chatId);
		// A later canonical read may confirm a lost acknowledgment. Clear
		// only the unchanged recovered draft, never the learner's newer work.
		const opening = openingDraftRef.current;
		if (opening !== null && textRef.current === opening) applyText("");
		if (draftRef.current === opening) draftRef.current = null;
		openingDraftRef.current = null;
		setOpeningError(false);
	}, [chatId, hasConfirmedConversation, applyText]);

	// THE BYOK REFUSAL (owner, 2026-09-22): a send that lands the server's
	// 503 models_not_configured envelope renders as the SETUP FLOW, never
	// the error banner. The gate refuses BEFORE the write-ahead persist,
	// so the server record is the truth minus the refused send — the
	// optimistic message is an orphan that goes HOME: refetch the record,
	// drop the orphan, put the draft back in the composer, open the
	// dialog (the prefilled tiers carry their picks, the unpinned ones the
	// "needed" marks). The draft stays in the composer until the learner
	// re-sends it (owner ruling 2026-10-09).
	useEffect(() => {
		if (!error) return;
		const missing = parseModelsRefusal(error.message);
		// The key-refusal twin (zero-keys wave): a pinned model whose
		// provider key is gone also restores the draft. With another provider
		// connected, repair belongs to the ordinary current-session picker;
		// otherwise setup derives its exclusive provider/loading stage.
		const keyRefused = parseProviderKeyRefusal(error.message);
		if (!missing && !keyRefused) return; // a real error keeps the honest banner
		// ORDER MATTERS: clearError() flips this effect's own dep (`error`)
		// and would cancel the in-flight work below — so the banner dismiss,
		// the draft restore, and the dialog open all land TOGETHER after the
		// record refetch (the honest truth minus the refused send).
		let cancelled = false;
		void (async () => {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`);
			if (!cancelled && res.ok) {
				const record = (await res.json().catch(() => null)) as { messages?: LhMessage[] } | null;
				if (Array.isArray(record?.messages)) setMessages(record.messages);
			}
			if (cancelled) return;
			if (draftRef.current !== null) {
				applyText(draftRef.current);
				draftRef.current = null;
			}
			clearError();
			if (keyRefused && catalogRef.current?.providers.some((p) => p.keyPresent)) openModelPicker();
			else setSetupOpen(true);
		})();
		return () => {
			cancelled = true;
		};
		// (setMessages/clearError are stable per useChat instance — the
		//  dep pair [error, chatId] is what the flow actually keys on.)
	}, [error, chatId]);
	// Voice dictation (STT wave, 2026-09-17): finals append at the end of
	// the current text (the page owns the separator, dictate-flush style);
	// interims ghost in the stats bar's middle slot next to the meter.
	// TAB CYCLES THE CHAT'S FIELDS (owner, keyboard round 2026-10-06):
	// reading-thinking → the active dock's field → the composer, in
	// visual order, forward-only with wrap; Tab from anywhere else
	// focuses the first live field (navigate IN). Gathered from live
	// DOM at event time — the docks mount and unmount, refs would go
	// stale. The quiz dock's rows↔thinking claim never reaches here.
	const cycleChatFields = useCallback((): readonly HTMLElement[] => {
		const pick = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
		return [
			...pick('[data-testid="reading-thinking-field"] [data-file-path-input]'),
			...pick('[data-testid="question-dock"] [data-file-path-input]'),
			...pick('[data-testid="practice-dock"] [data-file-path-input]'),
			...pick('[data-testid="composer"] [data-file-path-input]'),
		];
	}, []);
	useFieldCycle(cycleChatFields);
	const dictation = useDictation({
		// Ref-first (see textRef): the join is computed from the mirror so a
		// send resuming after `await finish()` reads the dictated tail.
		append: (t) => applyText(joinDictation(textRef.current, t)),
	});
	/* When a dictation run ends, the bare composer takes focus (owner
	 * 2026-10-01) — the hands are already on the keyboard from the stop.
	 * Falling edge of `active` only (idle→idle never focuses), and ONLY the
	 * composer: with a question pending the Composer is unmounted, the ref
	 * is null, and the thinking field is left alone by design. */
	const dictationWasActiveRef = useRef(false);
	const composerInputRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (dictation.active) {
			dictationWasActiveRef.current = true;
		} else if (dictationWasActiveRef.current) {
			dictationWasActiveRef.current = false;
			composerInputRef.current?.focus();
		}
	}, [dictation.active]);

	// Jobs never gate the composer (contracts.ts "THE ASYNC PROTOCOL" §4): job
	// tools resolve with an ack mid-turn, so the learner can interject while
	// sub-agents run — a feature, not a race: the wake pipeline queues steers
	// until the current turn ends. Only a QUESTION pending or a turn in
	// flight (client or server-side wake turn) gates sending.
	// A LIVE dictation also makes the composer sendable (owner 2026-10-01):
	// the spoken text is deferred in the run's buffer — Enter must be able
	// to trigger the finish-first send (see onSend), not be gated out by an
	// empty textarea. If nothing was said, the send is a harmless no-op.
	// Steering (2026-10-03): a turn in flight no longer gates the composer —
	// Enter while a turn runs STEERS it (the quiet queue above the composer);
	// a pending question still owns the interaction (the dock replaces the
	// composer, and there is no live turn to steer anyway — questions end
	// turns).
	// Compaction (owner round 14): the RUNNING state — compaction-changed
	// flips it; the send paths, canSend, and the docks gate on it (the
	// server's registry mutex is the structural gate; this is the
	// affordance).
	const [compacting, setCompacting] = useState(initiallyCompacting);
	// A failed model response (issue #110): Retry keeps the saved input
	// and completed work, without another learner message. Offered from
	// "error" too: a dropped stream leaves the model there, and send()
	// recovers from it. Later compaction requires new input instead.
	const retryable = (status === "ready" || status === "error") && !busy && !compacting && endsInFailedTurn(nativeMessages);
	const retryFailedTurn = () => retryFailedResponse(send, draftRef);
	const sendAllowed = !pending && !activeProblem && !compacting;

	/* THE PRACTICE PAUSE (owner round 16): between problems — practice
	 * kind, nothing active, nothing in flight, and at least one problem
	 * has ever been posed (the fresh session's opening turn is owed, not
	 * the move-on). Enter-on-empty and the Next chip both key on it. */
	const nextReady =
		kind === "practice" &&
		!pending &&
		!activeProblem &&
		!compacting &&
		!busy &&
		nativeMessages.some(
			(m) => (m as { role?: string }).role === "assistant" &&
				Array.isArray((m as { content?: unknown[] }).content) &&
				(m as { content: Array<{ type?: string; name?: string }> }).content.some(
					(b) => b.type === "toolCall" && b.name === "problem",
				),
		);
	const sendNext = useCallback(() => {
		if (!nextReady) return;
		void send({ type: "next" });
	}, [nextReady, send]);

	/* ENTER FROM ANYWHERE (owner round 16 refinement, 2026-10-06 —
	 * keyboard-first): the move-on must not require composer focus. The
	 * window-level Enter (typing surfaces and buttons excluded — a
	 * focused composer/button keeps its own lane, so no double fire)
	 * fires the signal from body focus, a scroll, anywhere. sendNext
	 * self-guards on nextReady, so the listener is inert outside the
	 * pause — the dock-mounted listeners are gone by then (docks unmount
	 * when nothing is active; the two never overlap). */
	useEnterSubmits(sendNext);

	const syncFromServer = useCallback(async (retries = 1): Promise<boolean> => {
		try {
			// Freshness gate (record-sync.ts): the snapshot must not wipe a
			// send (or any local advance) that happened while it was in flight.
			const moment = () => ({ busy: busyRef.current, messages: nativeMessagesRef.current });
			const start = moment();
			const res = await fetch(`/api/chats/${chatId}`);
			if (!res.ok) return false;
			const record = (await res.json()) as { messages?: LhMessage[]; turns?: TurnUsage[]; pricing?: SessionPricing; turnError?: string };
			const verdict = recordSyncVerdict(start, moment());
			if (verdict === "skip") return false;
			if (verdict === "retry") return retries > 0 ? syncFromServer(retries - 1) : false;
			if (Array.isArray(record.turns)) setTurns(record.turns);
			setPricing(record.pricing);
			if (!Array.isArray(record.messages)) return false;
			setMessages(record.messages, record.turnError);
			// The continuation seam (contracts.ts protocol §4): a job result
			// landing in the record leaves the agent owing a continuation — the
			// record ENDS on un-consumed results, the dock owns no question, and
			// nothing runs. The native fold (needsContinuation) is the old SDK
			// lastAssistantMessageIsCompleteWithToolCalls check.
			// Current model truth also guards retained/live failures: canonical
			// sync must never automatically replace a reply that failed to save.
			continueIfOwed(record.messages);
			return true;
		} catch { return false; /* retain the confirmed view on a transient read failure */ }
	}, [chatId, setMessages, continueIfOwed]);

	// The settled terminal's other half (stream-reattach wave): the
	// transport resolved turn-settled — no turn running, the record is
	// current. Drop the fallback busy state and adopt the record (its
	// continuation check fires the owed next turn, exactly as the poll's
	// settle branch always did).
	reattachSettledRef.current = () => {
		setTurnInFlight(false);
		void syncFromServer();
	};

	// ── Append-only record adoption (owner ground rules, 2026-09-15) ──
	// Content delivered into the record server-side — sub-agent
	// artifacts, abort notes — must become visible the
	// moment it persists, mid-turn included: it sits between messages, and
	// nothing about a running turn should hide it. The full snapshot sync
	// mid-stream is forbidden (it breaks the SDK's in-place continuation
	// merge — the stale-snapshot lesson), so adoption here is APPEND-ONLY
	// (the session hook's adoptRecord): insert the record's new ids in their canonical
	// order, never rewrite a local one, keep the in-flight tail last. The
	// full syncFromServer stays the net at idle (reorder, plan blocks, turns).
	const adoptAppendOnly = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}`);
			if (!res.ok) return;
			const record = (await res.json()) as { messages?: LhMessage[] };
			if (!Array.isArray(record.messages)) return;
			adoptRecord(record.messages);
		} catch {
			/* transient — the idle full sync is the net */
		}
	}, [chatId, adoptRecord]);

	// One 2s fallback adoption per submitted turn. Keep it across streaming
	// and ready transitions: an initial canonical read may have failed.
	const turnStartStatusRef = useRef(status);
	const turnStartTimerRefs = useRef(new Set<ReturnType<typeof setTimeout>>());
	useEffect(() => {
		const was = turnStartStatusRef.current;
		turnStartStatusRef.current = status;
		if (was === "submitted" || status !== "submitted") return;
		const timer = setTimeout(() => {
			turnStartTimerRefs.current.delete(timer);
			void adoptAppendOnly();
		}, 2000);
		turnStartTimerRefs.current.add(timer);
	}, [status, adoptAppendOnly]);
	useEffect(() => {
		const timers = turnStartTimerRefs.current;
		return () => { timers.forEach(clearTimeout); timers.clear(); };
	}, []);

	// The live plan popup (wave 4): opened by any transcript plan block, the
	// top-bar plan chip, and the dock band's marginalia.
	const [planOpen, setPlanOpen] = useState(false);
	// The transcript rows are memoized (components/transcript-rows.tsx):
	// their callbacks must be stable or every row re-renders per update.
	const openPlan = useCallback(() => setPlanOpen(true), []);
	const retryQuestion = useCallback((malformed: QuestionCall) => {
		draftRef.current = null;
		void send({ type: "retry-question", messageId: malformed.messageId, contentIndex: malformed.contentIndex, toolCallId: malformed.toolCallId });
	}, [send]);
	// Real plan presence — gates the marginalia's clickable flank. A JSX
	// element is always truthy; gating on the node alone mounted a phantom
	// (invisible, clickable) button in the bottom-right whenever a question
	// was pending with no plan yet (owner report, UI round 2026-10-01).
	const hasPlan = useMemo(() => planExists(messages), [messages]);
	// The coverage ring's refresh chain (extraction-UX redesign): bumped at
	// turn settle — the moment this session's uncovered mass changes.
	const [coverageTick, setCoverageTick] = useState(0);
	// The mermaid focus (chrome-melt wave, 2026-09-19): md-blocks' expand
	// button registers the chart source here; the overlay (and the plan
	// popup) mount INSIDE the session-area div — both are session-scoped, so
	// the drag bar stays sharp and draggable while a focus owns the area.
	const [mermaidFocus, setMermaidFocus] = useState<string | null>(null);
	// Figure focus (2026-10-07): the figure card's fullscreen button — same
	// overlay shell as mermaid, but carrying the raw svg + the card's invert
	// state so the fullscreen view stays faithful to the toggled card.
	const [figureFocus, setFigureFocus] = useState<{ svg: string; inverted: boolean } | null>(null);

	// Overlay mirrors for the layered-Esc gate (owner 2026-10-04): the
	// lh:kbd-abort-turn handler reads these at EVENT time — declared here
	// beside their states, consumed below wherever the states live.
	const mermaidFocusRef = useRef(mermaidFocus);
	mermaidFocusRef.current = mermaidFocus;
	// The figure focus rides the mermaid layer in the Esc gate — the same
	// overlay class (session-scoped diagram focus, Esc claimed at the
	// document level by the overlay itself); the window chain must stay out.
	const figureFocusRef = useRef(figureFocus);
	figureFocusRef.current = figureFocus;
	const planOpenRef = useRef(planOpen);
	planOpenRef.current = planOpen;
	const setupOpenRef = useRef(setupOpen);
	setupOpenRef.current = setupOpen;
	// The session's live plan (drives the top-bar chip; the marginalia
	// derives its own from the same transcript).
	const planTree = useMemo(() => latestTree(messages), [messages]);
	// The lesson-tracking card (owner, 2026-11-02): the problem set and the
	// mistake log, derived by the session model from the native record and
	// the live executions (the tracking tools never render in the
	// transcript view — core/lesson-tracking.ts). Since 2026-11-05 (owner)
	// it also carries a teach lesson's plan — each step's position and check
	// score, from the same transcript as the plan chip (core/plan-progress.ts);
	// never in cram or practice. The chip shows while any section exists.
	const planProgress = useMemo(() => lessonPlanProgress(planTree, messages, { cram, practice: kind === "practice" }), [planTree, messages, cram, kind]);
	const hasTracking = hasLessonTracking(tracking) || planProgress !== null;
	const trackerCard = useLessonTrackerShown();
	// "Practice weak spots" (owner, 2026-11-06): the card's button opens a
	// new practice session in this lesson's project, seeded with its weak spots.
	const router = useRouter();
	const weakSpotsStarterRef = useRef(new SessionStarter());
	const practiceWeakSpots = useCallback(async (spots: string[]) => {
		// The lesson may have moved since the page loaded: ask the chat list for its project now.
		const listed = await fetch("/api/chats")
			.then((r) => (r.ok ? (r.json() as Promise<{ chats?: Array<{ id: string; projectId?: string }> }>) : null))
			.catch(() => null);
		const row = listed?.chats?.find((c) => c.id === chatId);
		const project = row ? row.projectId : projectId;
		router.push(await startWeakSpotsPractice(titleText, spots, project, fetch, weakSpotsStarterRef.current));
	}, [router, titleText, projectId, chatId]);
	// The dock's reserved tail height (DockOverlay reports it; the spacer at
	// the end of the transcript renders it). Lives here because the spacer is
	// inside the scroller while the dock overlays OUTSIDE it — two parents.
	// 208 ≈ gradient(96) + composer block(~112): the SSR/pre-hydration
	// guess so the static paint has a sane tail. The first layout effect
	// replaces it with the measured truth before paint.
	const [dockReserve, setDockReserve] = useState(208);
	// A docked pinned demo/diagram takes the progress card's column; the
	// PROGRESS chip then shows the card over it (progressOverPin, reset per pin).
	const getTranscriptScroller = useCallback(() => scrollContextRef.current?.scrollRef.current ?? null, []);
	const pinned = usePinnedVisual({ messages, tutorPin, areaRef: sessionFindScopeRef, bottomReserve: Math.max(0, dockReserve - GRADIENT_H), getScroller: getTranscriptScroller });
	pinEscRef.current = pinned;
	const [progressOverPin, setProgressOverPin] = useState(false);
	const pinnedJob = pinned.target?.jobId ?? null;
	useEffect(() => setProgressOverPin(false), [pinnedJob]);
	const trackerShown = pinned.docked ? progressOverPin : trackerCard.shown;
	// The plan diagram goes under the card's plan list when the card has room
	// for it, else to the dock band's flank — never both; a docked pin hides it.
	const [planInCard, setPlanInCard] = useState(false);
	const planDiagram = hasPlan && !(pinned.docked && !progressOverPin) ? <PlanMarginalia messages={messages} /> : undefined;
	const toggleTracker = pinned.docked ? () => setProgressOverPin((v) => !v) : trackerCard.toggle;
	// Room for the card (owner, "make room"): while it shows on a session
	// area wide enough for both, the transcript column keeps clear of it.
	const trackerRoom = lessonTrackerRoom(hasTracking && trackerCard.shown && !pinned.docked);

	// ── Session usage (wave-4 stats bar) ──
	// The money channel: the record's turns log and read-time server Pi
	// pricing projection. Seeded once on mount (the page doesn't carry turns),
	// refreshed when the local stream settles (each turn appends to the log
	// server-side), and kept fresh by syncFromServer whenever it already
	// fetches the record. No turns yet → the bar renders "—" everywhere.
	const [turns, setTurns] = useState<TurnUsage[]>([]);
	const [pricing, setPricing] = useState<SessionPricing | undefined>();
	// The per-chat model control state (model-picker writes via PUT; the
	// record is the source of truth, lifted here so the stats bar re-renders).
	const syncTurns = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${chatId}?only=stats`);
			if (!res.ok) return;
			const record = (await res.json()) as { turns?: TurnUsage[]; pricing?: SessionPricing };
			if (Array.isArray(record.turns)) setTurns(record.turns);
			setPricing(record.pricing);
		} catch {
			// transient blip: stats stay on the last known figures
		}
	}, [chatId]);
	useEffect(() => {
		void syncTurns();
	}, [syncTurns]);
	// Settlement refreshes coverage and canonical messages/stats. Without a
	// durable-settlement announcement (for example Stop), refresh stats only.
	const prevStatusRef = useRef(status);
	useEffect(() => {
		const transitioned = prevStatusRef.current !== "ready" && status === "ready";
		// Every path (the old early-return skipped this on the transition
		// branch — the re-fire-on-dep-churn wart, fixed S3).
		prevStatusRef.current = status;
		if (!transitioned) return;
		// The coverage ring re-reads at turn settle too (extraction-UX
		// redesign, 2026-09-24); the ring's own running-poll handles runs.
		setCoverageTick((t) => t + 1);
		// CANONIZATION (fix B, the duplicate-previous-message bug, 2026-10-02):
		// turn-settled for OUR OWN turn arrives while the stream is still open
		// (endTurn emits from onFinish before the response terminates, so the
		// SSE frame reliably beats [DONE]) — the handler below cannot sync
		// there, it flags instead, and THIS flip consumes the flag: the record
		// reflects durable truth (a failed settlement retains its notice,
		// not its unsaved reply), so replacing the view absorbs the tail's
		// streamed c_-id copies into base under their server ids. Without
		// this the tail kept those copies forever and the next send's
		// steer-adoption window rendered them a second time. The wake handoff
		// cannot be missed by this sync: the wake fires only after the idle
		// gates + grace (≥750ms past this flip), so its turn-started event
		// lands at an idle, already-canonical view and attaches normally.
		if (settleAnnouncedRef.current) {
			settleAnnouncedRef.current = false;
			void syncFromServer().then(ok => { if (!ok) void syncTurns(); });
		} else void syncTurns();
		// (The extraction-discovery nudges that lived here died at S5: the
		// pipeline announces every phase on the events channel.)
	}, [status, syncTurns, syncFromServer]);

	// A stream that died MID-FLIGHT (network): the runner decoupled the turn
	// from its view, so the server turn runs ON behind the error banner —
	// re-enter the in-flight watch (the 1500ms fallback poll adopts at
	// settle) instead of leaving the session blind until the next send's
	// 409 merge-retry heals it. One record check per error transition.
	const prevErrorStatusRef = useRef(status);
	useEffect(() => {
		const was = prevErrorStatusRef.current;
		prevErrorStatusRef.current = status;
		if (was === "error" || status !== "error") return;
		let cancelled = false;
		void (async () => {
			try {
				const res = await fetch(`/api/chats/${chatId}`);
				if (!res.ok || cancelled) return;
				const record = (await res.json()) as { turnInFlight?: boolean };
				if (cancelled) return;
				if (record.turnInFlight === true) setTurnInFlight(true);
				else void syncFromServer();
			} catch {
				/* transient — the banner stands; the next send's merge-retry heals */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [status, chatId, syncFromServer]);

	// ── Central job observability (contracts.ts "THE ASYNC PROTOCOL" §4) ──
	// ONE fetch of /api/jobs drives every job surface (transcript dispatch
	// cards, the sub-agents panel) and re-syncs the transcript exactly once
	// when a job settles. PUSH (architecture S4, 2026-10-02): the store
	// announces every job write on the events channel; the interval poll and
	// its pollMs/jobPartCount gating are RETIRED. The view fetches once on
	// mount, once per jobs-changed announcement (trailing-debounced — a
	// sub-agent run writes activity-line bursts; 250ms coalesces them at or
	// below the old 1s poll cadence), and once on channel resync.
	//
	// A settle no longer implies the record is complete: CONTINUATION
	// COALESCING flips the job done at claim time — while the learner's own
	// answer turn is still streaming (and a settle can race a second job's
	// wake turn). Syncing mid-turn would swap in a stale snapshot
	// mid-stream, which breaks the SDK's in-place continuation merge
	// (duplicate message ids). So: a settle during a busy turn defers the
	// sync; the next idle fetch adopts the finished record.
	const [jobs, setJobs] = useState<JobRecord[]>([]);
	const localStreamRef = useRef(false);
	localStreamRef.current = localStream;
	const jobStatusRef = useRef<Map<string, string>>(new Map());
	// A settle seen during a busy turn — the sync is owed, not dropped.
	const pendingSyncRef = useRef(false);
	// (The dispatch nudge effect that lived here — refreshActivity per new
	// dispatch tool part — died at S5: the store announces jobs-changed at
	// the dispatch write; the dock subscribes.)
	// The trailing debounce for jobs-changed announcements (one timer), and
	// the ref the timer fires through (a stale closure must never fetch an
	// old chatId).
	const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const fetchJobsRef = useRef<() => void>(() => {});
	const fetchJobs = useCallback(async () => {
		try {
			const res = await fetch(`/api/jobs?chatId=${encodeURIComponent(chatId)}`);
			if (!res.ok) return;
			const data = (await res.json()) as { jobs?: JobRecord[]; turnInFlight?: boolean };
			const list = data.jobs ?? [];
			let settled = false;
			for (const job of list) {
				if (jobStatusRef.current.get(job.id) === "running" && job.status !== "running") settled = true;
				jobStatusRef.current.set(job.id, job.status);
			}
			const busy = localStreamRef.current || data.turnInFlight === true;
			if (settled || (pendingSyncRef.current && !busy)) {
				// A whole settled batch shares one read; streaming views adopt
				// append-only until the canonical idle sync is safe.
				pendingSyncRef.current = busy;
				if (busy) void adoptAppendOnly(); else void syncFromServer();
			}
			setJobs(list);
			// (Wake-turn adoption that lived here — the turnInFlight attach
			// line — died at S3: turn-started on the events channel owns
			// discovery now. turnInFlight is STILL READ above: the settle
			// logic's idle check needs it.)
		} catch {
			/* transient fetch failure — the next jobs-changed announcement re-fetches */
		}
	}, [chatId, syncFromServer, adoptAppendOnly]);
	fetchJobsRef.current = () => void fetchJobs();
	// Fetch the current jobs on mount and chat switch.
	useEffect(() => { void fetchJobs(); }, [fetchJobs]);
	useServerEvent("jobs-changed", (p) => {
		if (p.chatId != null && p.chatId !== chatId) return; // ours or unattributed
		if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
		fetchDebounceRef.current = setTimeout(() => {
			fetchDebounceRef.current = undefined;
			fetchJobsRef.current();
		}, 250);
	});
	// Reconnect catch-up: events missed while the channel was down.
	useServerResync(() => fetchJobsRef.current());
	useEffect(
		() => () => {
			if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
		},
		[],
	);

	// ── Server-initiated turn discovery (push-architecture S3, 2026-10-02) ──
	// Every turn THIS chat runs is announced on the events channel — the
	// probe→teach handoff, a job wake, another tab's send, the
	// missed-on-mount case. This replaces the retired watch loop and the
	// 1500ms fallback record poll: discovery is no longer a polling window
	// that can expire. Handlers read REFS, not closure state — events fire
	// between renders, and a ref holds the live value at event time.
	const statusRef = useRef(status);
	statusRef.current = status;
	/** Fix B (2026-10-02): turn-settled arrived for OUR OWN turn — the
	 * record is durable (endTurn fires only after persistTurn); the ready
	 * flip consumes this flag to canonize the view onto the record. See the
	 * settle effect and the turn-settled handler below. */
	const settleAnnouncedRef = useRef(false);
	useServerEvent("turn-started", (p) => {
		// Known non-issue: beginTurn emits before registerTurn in the same
		// synchronous request flow; a GET /stream inside that sub-ms window
		// gets a settled response — unwinnable by a network round-trip,
		// self-healing via the eventual turn-settled. Do not engineer around.
		if (p.chatId !== chatId) return;
		if (localStreamRef.current) return; // our OWN turn — the 409-race guard
		if (turnInFlightRef.current) return; // already attached
		attachToRunningTurn();
	});
	useServerEvent("turn-settled", (p) => {
		if (p.chatId !== chatId) return;
		if (localStreamRef.current) {
			// Our own [DONE] path owns the BUSY settle — but not a no-op (fix B,
			// 2026-10-02): the event is the record-durable guarantee (endTurn
			// fires only after persistTurn), and it reliably beats [DONE] here
			// (endTurn emits from onFinish before the response terminates). Flag
			// it; the ready flip consumes the flag and canonizes the view onto
			// the record. (If [DONE] somehow won this race instead, this branch
			// didn't run and the fully-idle branch below already synced.)
			settleAnnouncedRef.current = true;
			return;
		}
		if (turnInFlightRef.current) {
			// The attached stream's terminal frame owns the normal settle —
			// syncing HERE would swap a stale snapshot mid-stream (the
			// continuation-coalescing law, see the jobs poll above). Only
			// the error case heals: the attached stream died, and the settle
			// says persistTurn has made the record durable truth.
			if (statusRef.current === "error") {
				setTurnInFlight(false);
				clearError();
				void syncFromServer();
			}
			return;
		}
		// Fully idle — a turn we never saw (every window missed): adopt now.
		void syncFromServer();
	});
	useServerEvent("compaction-changed", (p) => {
		// The settle-kick's background summary: while it runs, sends gate
		// (the next turn's server-side ensureCompacted awaits it anyway —
		// this only keeps the affordance honest). On finish, record-changed
		// (emitted by the compaction write itself) carries the marker in.
		if (p.chatId !== chatId) return;
		setCompacting(p.running);
	});
	useServerEvent("record-changed", (p) => {
		// The silent dismissal write (A2, 2026-10-03): no turn ever ran, so
		// only the record moved. Other tabs and post-error windows adopt;
		// our OWN dismissal already rendered its optimistic append — syncing
		// here too is harmless (the adoption law swaps local ids for the
		// server's). Busy states ignore it: a running turn owns the view,
		// and the write is 409-guarded against exactly that anyway.
		if (p.chatId !== chatId) return;
		if (localStreamRef.current || turnInFlightRef.current) return;
		void syncFromServer();
	});

	const onSend = () => {
		if (pending || compacting) return;
		/* FINISH DICTATION FIRST (owner, 2026-10-01): a learner who keeps
		 * talking right through Enter must not lose the tail — stop the run,
		 * let the last finals land in the composer, then send the REF value
		 * (the flush lands via setState, invisible to this closure). */
		if (!dictation.active) {
			doSteerOrSend();
			return;
		}
		void dictation.finish().then(doSteerOrSend);
	};
	const doSend = () => {
		if (busy || pending || compacting) return;
		const t = textRef.current.trim();
		if (!t) return;
		if (zeroKeys) {
			setSetupOpen(true);
			return;
		}
		if (selectedModelUnavailable(catalog, selectedModel)) {
			openModelPicker();
			return; // No optimistic send and no change to the learner's draft.
		}
		if (openingDraftRef.current !== null) {
			deliverOpeningPrompt(t);
			return;
		}
		draftRef.current = t; // the refusal flow's preserve-and-replay seam
		applyText("");
		void send({ type: "text", text: t });
	};

	// "Accept plan" (plan-accept.tsx): the same preflight as an ordinary send
	// (an unavailable selected model opens the picker first), with the fixed
	// go-ahead text and the learner's draft left alone.
	const acceptPlan = () => {
		if (busy || pending || compacting) return;
		if (zeroKeys) {
			setSetupOpen(true);
			return;
		}
		if (selectedModelUnavailable(catalog, selectedModel)) {
			openModelPicker();
			return;
		}
		// Nothing of the learner's to restore if the send is refused: clear the
		// replay slot so a refusal can't put an older sent message over the
		// current draft.
		draftRef.current = null;
		void send({ type: "text", text: PLAN_ACCEPT_TEXT });
	};

	// New input interrupts a busy response; idle input uses ordinary Send.
	const doSteerOrSend = () => {
		if (pending || compacting) return;
		const t = textRef.current.trim();
		if (!t) return;
		if (busy) {
			applyText("");
			void steer(t).then(accepted => {
				if (!accepted) applyText(restoreInterruptedDraft(textRef.current, t));
			});
			return;
		}
		doSend();
	};

	return (
		<ChatActionsContext.Provider
			value={{
				chatId,
				syncFromServer,
				sendText: (t: string) => {
					void send({ type: "text", text: t });
				},
				openSetup: () => setSetupOpen(true),
			}}
		>
		<SessionMermaidContext.Provider
			value={{
				openMermaid: setMermaidFocus,
				openFigure: (svg, inverted) => setFigureFocus({ svg, inverted }),
			}}
		>
		<JobsContext.Provider value={jobs}>
		<PinnedVisualContext.Provider value={pinned.context}>
		{/* The session surface: the transcript column (header + scroller) and
		    the plan-tree panel as full-height SIBLINGS — the panel spans top to
		    bottom exactly like the left sidebar, and the header (name + phase
		    chip) spans from the left sidebar's edge to the panel's edge. The
		    dock overlays the column bottom (outside the scroller); a spacer in
		    the transcript reserves its height. */}
		<div className="relative flex lh-h-screen">
			<div className="flex min-w-0 flex-1 flex-col">
				{/* The top bar is its own block (owner, top-fade round 4): in flow
				    above the scroller on the plain page background — no gradient. Its
				    bottom outline (border-b border-border) matches the one that
				    separates the left sidebar — same width, same color (owner, r5).
				    h-15 (60px), not py-2: the toggle (a size-9 icon button) renders
				    only while the sidebar is CLOSED — an auto-height row would
				    collapse when it disappears and slide the title + chip up.
				    60px is an ALIGNMENT, not just a size: it equals the sidebar's
				    LH wordmark band, so the header's border-b continues that
				    band's bottom edge as one line across the app (owner, round 6). */}
				<TopBar
					// While renaming the bar is NOT a drag surface: app-region:drag
					// would eat the mousedown, so click-to-escape (below) could
					// never fire. Rename mode is interactive mode (owner ask) —
					// TopBar's one escape hatch.
					drag={!renaming}
					onMouseDown={(e) => {
						// Escape hitbox: any mousedown outside the input itself blurs
						// it, running the existing onBlur commit path. The input is
						// shrink-to-fit (field-sizing), so the rest of the bar is
						// this spacer + inert chips — all click-to-exit (owner ask).
						if (renaming && e.target !== titleInputRef.current) titleInputRef.current?.blur();
					}}
				>
					{renaming ? (
						<>
							<input
								ref={titleInputRef}
								value={titleDraft}
								onChange={(e) => setTitleDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") void commitRename(titleDraft);
									// stopPropagation claims the Esc (keyboard wave A):
									// closing rename must not also abort a turn.
									else if (e.key === "Escape") {
										e.stopPropagation();
										setRenaming(false);
									}
								}}
								onBlur={() => void commitRename(titleDraft)}
								spellCheck={false}
								aria-label="Session title"
								title="Rename this session"
								className="lh-no-drag min-w-[8ch] max-w-[70%] shrink-0 bg-transparent font-title text-3xl tracking-tight caret-current outline-none [field-sizing:content]"
							/>
							{/* flex-1 spacer during rename too, so the chips stay at
							    the right edge; clicks here commit via the header
							    mousedown handler. */}
							<div className="min-w-4 flex-1" aria-hidden="true" />
						</>
					) : (
					<>
						<Hint
							// F2 renames (registry) — surfaced on the hover.
							label="Rename session"
							action="rename-session"
							side="bottom"
						>
<button
							type="button"
														onClick={() => {
								setTitleDraft(titleText);
								setRenaming(true);
							}}
							className="lh-no-drag -mx-1.5 min-w-4 shrink cursor-text truncate rounded-md px-1.5 text-left font-title text-3xl tracking-tight transition-colors hover:bg-accent"
						>
							{titleText}
							</button>
						</Hint>
							{/* flex-1 spacer: keeps the chips at the right edge AND stays a
							    drag surface (no carve-out) — the freed bar is grippable. */}
							<div className="min-w-4 flex-1" aria-hidden="true" />
					</>
					)}
					<Hint label="Temporary side tutor" action="toggle-side-tutor" side="bottom">
						<button type="button" aria-label="Open side tutor" aria-expanded={sideTutor !== null} onClick={toggleSideTutor} className="lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground"><MessageCircleQuestionIcon className="size-3.5 text-primary" aria-hidden />Side tutor</button>
					</Hint>
					{/* The plan chip (owner, plan-placement round): session-level
					    structure beside the phase chip — access to the full-DAG popup
					    at every width; the marginalia is the wide-screen glance view. */}
					{planTree && (
						<Hint label="Open the full plan" side="bottom">
<button
							type="button"
							data-testid="plan-chip"
							onClick={(e) => {
								blurAfterPointerClick(e);
								setPlanOpen(true);
							}}
							className="lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground"
						>
							<WaypointsIcon className="size-3.5 text-primary" aria-hidden />
							Plan
						</button>
</Hint>
					)}
					{hasTracking && <LessonTrackerChip shown={trackerShown} onToggle={toggleTracker} />}
					{/* The extraction ring (owner-locked redesign, 2026-09-24): fills
					    with uncovered vs the chunk threshold, pulses while a run is in
					    flight, vanishes when the graph is off. Click → the exact
					    numbers. Before the phase label — the chips cluster right. */}
					{/* Practice (owner, 2026-10-04): the coverage ring hides —
				    practice never extracts, so an ever-filling ring with no
				    run behind it would lie. */}
					{kind !== "practice" && <CramToggle chatId={chatId} on={cram} beginSave={beginCramSave} />}
					{/* The lesson's question type (owner, 2026-11-03): the teacher's
					    tools, so never for practice and not while the prober runs. */}
					{showsQuestionTypeChip(kind, phases.at(-1) ?? "probe") && (
						<QuestionTypeChip chatId={chatId} stored={lessonQuestionType.questionType} cram={cram} initialAgentTools={agentTools} beginSave={lessonQuestionType.begin} />
					)}
					{kind !== "practice" && <CoverageRing chatId={chatId} refreshKey={coverageTick} />}
					{/* Practice sessions: no phase arc — a quiet Practice tag
					    instead of the phase chip. */}
					{kind === "practice" ? (
						<span
							data-testid="phase-chip"
							data-phase="practice"
							aria-hidden="true"
							className="pointer-events-none flex shrink-0 select-none items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
						>
							<DumbbellIcon className="size-3" />
							Practice
						</span>
					) : (
						<PhaseChip phase={phases.at(-1) ?? "probe"} />
					)}
				</TopBar>

				<SessionFind scopeRef={sessionFindScopeRef} scrollContextRef={scrollContextRef} />
				<div ref={sessionFindScopeRef} className={`relative flex min-h-0 flex-1 ${trackerRoom.area}`}>
				<Conversation className="h-full min-w-0 flex-1" initial="instant" contextRef={scrollContextRef}>
					<SessionMessageNavigation />
					<ConversationContent className="min-h-full gap-0 p-0">
						<div data-session-find-root="" className={`${COLUMN} flex flex-1 flex-col gap-4 pt-4 ${trackerRoom.column}`}>
							{messages.length === 0 && !busy && (
								<ConversationEmptyState
									title="New session"
									description="The teacher will open by probing what you already know."
								/>
							)}

							<TranscriptRows
								messages={messages}
								phases={phases}
								transcript={transcript}
								streaming={status === "streaming"}
								activeMessageId={status === "streaming" ? nativeMessages.at(-1)?.id : undefined}
								malformedQuestions={malformedQuestions}
								busy={busy}
								questionPending={!!pending}
								compacting={compacting}
								onRetryQuestion={retryQuestion}
								onOpenPlan={openPlan}
							/>

							{/* THE placeholder, ACTION-gated (owner, optimistic round
							    3, 2026-10-02): spinner + shimmered Thinking… from the
							    instant of any action that produces tokens — send,
							    answer, session start, reattach (status flips to
							    submitted SYNCHRONOUSLY with the action) — until the
							    turn's first APPLIED event, where the stream takes over
							    with the same look: an arrived-but-empty message renders
							    the thinking ROW (view.ts projects one empty reasoning
							    part), so submitted ⟺ placeholder and streaming ⟺ a
							    rendered row, mutually exclusive by construction.
							    Protocol events (agent_start) apply nothing and release
							    nothing — the placeholder covers the whole
							    provider-connect gap. turnInFlight: the same state
							    entered by external discovery (wake) / the poll
							    fallback. Never collapsible itself. */}
							{/* Compaction (owner round 15): the same register as the
						    thinking placeholder — a visible session-wide state while
						    the summarizer holds the model gate. Mutually exclusive with
						    the THINKING placeholder by construction (the gate sits
						    BEFORE beginTurn; the settle kick runs after endTurn). */}
							{compacting && (
								<span className="flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
									<BrailleSpinner label="Compacting context" />
									<Shimmer duration={1}>COMPACTING CONTEXT…</Shimmer>
								</span>
							)}
							{(status === "submitted" || turnInFlight) && (
								<span className="flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
									<BrailleSpinner label="Thinking" />
									<Shimmer duration={1}>
										THINKING…
									</Shimmer>
								</span>
							)}
							{openingError && <p role="alert" className="text-sm text-destructive">{OPENING_PROMPT_FAILURE}</p>}
							{settingsRefreshError && <p role="alert" className="text-xs text-destructive">{settingsRefreshError}</p>}
							{error && (
								<div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">
									<span>Something went wrong: {error.message}</span>
									{retryable && (
										<Button variant="outline" size="xs" data-testid="retry-failed-turn" onClick={retryFailedTurn}>
											Retry
										</Button>
									)}
								</div>
							)}
						</div>

						{/* The dock's reserved tail (DockOverlay reports its height):
						    keeps at-rest transcript content scrolling fully clear of
						    the overlay — the flow-space replacement for the old
						    sticky dock. Zero only pre-measurement (the first layout
						    effect reports before paint). */}
						<div aria-hidden data-testid="dock-spacer" style={{ height: dockReserve }} />
				</ConversationContent>
				{/* The dock: an overlay sibling of the scroller (the
				    use-stick-to-bottom pattern). The scroll-down button lives
				    INSIDE the overlay now (owner refinement round, 2026-09-24):
				    anchored to the dock block's top edge, so it rides every
				    height morph (typing, a question growing the band, the
				    fold) and NEVER overlaps the composer. */}
				<DockOverlay
					pending={pending}
					initialQuestionDraft={pending ? questionDraft(pending.key)?.form : undefined}
					onSaveQuestionDraft={(form) => { if (pending) saveQuestionDraft(pending.key, { form }); }}
					practice={activeProblem}
					compactionRunning={compacting}
					onSubmitThinking={submitThinking}
					chatId={chatId}
					onModelChange={setSelectedModel}
					plan={planInCard ? undefined : planDiagram}
					onOpenPlan={() => setPlanOpen(true)}
					teachingCheck={teachingCheck}
					requiresReveal={requiresReveal}
					showReadingThinking={showReadingThinking}
					readingThinking={readingThinkingSeed.value}
					readingThinkingRevision={readingThinkingSeed.revision}
					onReadingThinking={applyReadingThinking}
					phase={phases.at(-1) ?? "probe"}
					turns={turns}
					contextTokens={contextTokens}
					cliContextWindow={cliContextWindowOf(nativeMessages)}
					pricing={pricing}
					onReserve={setDockReserve}
					room={trackerRoom.dock}
					dictationSlot={<DictationBar dictation={dictation} />}
					dictationCancel={dictation.cancel}
					queuedSteers={visibleQueuedSteers(steerQueue, nativeMessages)}
					setupCta={
						offersPlanAccept({ kind, cram, phase: phases.at(-1), hasPlan: !!planTree && planTree.nodes.length > 0, awaitingReply: awaitingPlanReply(nativeMessages as never), sendAllowed, busy, retryable }) && !zeroKeys && configured ? (
							<PlanAcceptBar onAccept={acceptPlan} onChange={() => composerInputRef.current?.focus()} />
						) : zeroKeys ? (
							<ZeroKeysPill onOpen={() => setSetupOpen(true)} />
						) : (
							!configured && (
								<div className="pointer-events-auto mb-2 flex justify-center">
									<button
										type="button"
										data-testid="setup-cta"
										onClick={() => setSetupOpen(true)}
										className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent cursor-pointer"
									>
										Set up your models
									</button>
								</div>
							)
						)
					}
					composer={
						<ChatSessionComposer
							// Stop aborts ANY in-flight turn (stream-reattach wave): the
							// square renders while a reattached/wake turn runs too — the
							// abort channel kills it server-side; stop() alone would
							// only detach our view.
							busy={busy}
							value={textRef.current}
							revision={composerDraftRevision}
							onChange={recordComposerText}
							inputRef={composerInputRef}
							onSend={onSend}
							onStop={abortInFlightTurn}
							sendAllowed={sendAllowed}
							dictationActive={dictation.active}
							onEscape={dictation.active ? dictation.cancel : undefined}
							// The pause affordance (owner round 16): the placeholder
							// IS the hint — empty state, exactly where Enter-on-empty
							// applies.
							nextProblem={nextReady}
							onNext={sendNext}
							placeholder={nextReady ? "Ask anything, or press Enter for the next one." : undefined}
						/>
					}
					onSubmitAnswer={(output) => {
						if (!pending) return;
						// THE ANSWER IS THE QUESTION CALL'S TOOL RESULT (fork 1, owner
						// 2026-09-26): one input event, one turn — the hook appends
						// the optimistic graded result (the AnsweredCard shows at
						// once) and the server's write-ahead persists it before the
						// turn; the teacher's reaction streams below it. Dismissals
						// ride the same callback (QuestionAnswerData.dismissed). The
						// reading-thinking draft rides along (owner 2026-10-03) — the
						// check answer is its only carrier.
						saveQuestionDraft(pending.key, { readingThinking: readingThinkingRef.current });
						const reading = readingThinkingRef.current.trim() || undefined;
						// The pending-id effect clears this only when the question
						// actually leaves. An offline preflight keeps the draft visible.
						submitAnswer(pending.tool, pending.toolCallId, reading ? { ...output, readingThinking: reading } : output, pending.key);
					}}
				/>
				</Conversation>
				{/* The pinned demo/diagram's docked column (the card itself stays
				    in its transcript row, restyled over this column). */}
				{pinned.dockColumn}
				{/* The tracking card: top-right over the transcript, below the
				    session-scoped focuses (z-40) and clear of the dock. */}
				{hasTracking && trackerShown && <LessonTrackerCard tracking={tracking} plan={planProgress} bottomReserve={Math.max(0, dockReserve - GRADIENT_H)} onPracticeWeakSpots={configured && !zeroKeys ? practiceWeakSpots : undefined} planView={pending ? planDiagram : undefined} onPlanViewPlaced={setPlanInCard} onOpenPlan={openPlan} />}
				{pinned.drawerTab}

				{/* The session-scoped focuses (chrome-melt wave, 2026-09-19): mounted
				    INSIDE the session area — absolute inset-0 siblings of the scroller,
				    so they own the area below the drag bar, right of the sidebar, and
				    the top bar stays sharp + draggable while a focus is open. */}
				{mermaidFocus !== null && (
					<MermaidOverlay chart={mermaidFocus} onClose={() => setMermaidFocus(null)} />
				)}
				{figureFocus !== null && (
					<MermaidOverlay
						svg={figureFocus.svg}
						inverted={figureFocus.inverted}
						onClose={() => setFigureFocus(null)}
					/>
				)}
				{planOpen && <PlanPopup messages={messages} onClose={() => setPlanOpen(false)} />}
				<AbortTurnDialog mode={abortAsk} onClose={() => setAbortAsk(null)} onConfirm={confirmAbort} busy={busy} />
				</div>
			</div>
			{sideTutor && <SideTutor chatId={chatId} selectedText={sideTutor.selectedText} onClose={closeSideTutor} />}
		</div>
		</PinnedVisualContext.Provider>
		</JobsContext.Provider>
		</SessionMermaidContext.Provider>
		{/* The BYOK setup flow (owner, 2026-09-22): one mount serves the
		    persistent CTA, the refused-send interception, and the job cards'
		    deep-link. Save keeps the draft in the composer — it never sends
		    (owner ruling 2026-10-09); Esc also keeps it (the dialog is
		    closable by design — the gate is the server, not this modal). */}
		<SetupDialog
			open={setupOpen}
			onClose={() => setSetupOpen(false)}
			onDone={() => {
				setSetupOpen(false);
				// Save only saves (owner ruling 2026-10-09): the draft went
				// home into the composer at refusal time and STAYS there —
				// the learner sends it themselves.
			}}
		/>
		</ChatActionsContext.Provider>
	);
}

/** The layered-Esc ruling (owner, 2026-10-04): an open overlay claims Esc —
 *  closing itself — before the abort chain may open its confirm. A mermaid
 *  focus, the plan popup, or the setup dialog over a pending question must
 *  close the OVERLAY, never dismiss the question underneath. Priority is
 *  stacking order: the abort confirm (topmost, claims via its own dialog),
 *  then the session overlays (mermaid paints above plan — later in DOM),
 *  then setup (self-closing — the gate only must not fire), then the
 *  2026-10-02 abort chain proper (question before turn). */
export type EscAbortTarget = "mermaid" | "pin-expanded" | "plan" | "setup" | "pin-drawer" | "question" | "problem" | "turn" | null;
	/**
 * Does the opening topic still owe its first send? The topic is the
 * server's ?prompt= or the sessionStorage stash. The gate is "no real
 * conversation yet" (no user/assistant message) — NOT emptiness: a
 * session started with map picks carries a graph-context MARKER as
 * message[0], and that scaffolding must never swallow the first send
 * (owner report, 2026-10-04: the turn went dead behind it — the old
 * `length === 0` check saw the marker and refused to fire).
 */
export function initialPromptOwed(messages: readonly { role: string }[], prompt: string | undefined): boolean {
	if (!prompt) return false;
	return !messages.some((m) => m.role === "user" || m.role === "assistant");
}

export function escAbortTarget(s: {
	abortAsk: boolean;
	mermaidFocus: boolean;
	planOpen: boolean;
	setupOpen: boolean;
	pending: boolean;
	/** An active practice problem (practice sessions, 2026-10-04): Esc
	 *  opens the discard confirm — below a pending question (the two
	 *  never coexist, but the layering stays strict), above the turn
	 *  abort (a live turn can be running BEHIND an idle problem only in
	 *  teaching sessions — practice problems end their pose turns). */
	problem: boolean;
	busy: boolean;
	/** A pinned demo shown over the whole area (components/pinned-visual.tsx). */
	pinExpanded?: boolean;
	/** The pin drawer (narrow layouts): an open drawer claims Esc to close
	 *  above the question; a closed one opens only on an otherwise unclaimed
	 *  Esc, so it never steals the question dismissal or the turn abort. */
	drawer?: "open" | "closed" | null;
}): EscAbortTarget {
	if (s.abortAsk) return null; // the popup's own Esc — claimed by the dialog
	if (s.mermaidFocus) return "mermaid";
	if (s.pinExpanded) return "pin-expanded";
	if (s.planOpen) return "plan";
	if (s.setupOpen) return "setup";
	if (s.drawer === "open") return "pin-drawer";
	if (s.pending) return "question";
	if (s.problem) return "problem";
	if (s.busy) return "turn";
	if (s.drawer === "closed") return "pin-drawer";
	return null;
}
