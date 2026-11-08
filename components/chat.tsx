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
import { MermaidOverlay, SessionOverlayContext } from "@/components/session-overlay";
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
import { StatsBar } from "@/components/stats-bar";
import { useSessionRename } from "@/components/session-rename";

/** The transcript column: full session width with a thin px-6 margin. The
 *  composer/question dock is narrower (DOCK in dock-overlay.tsx). */
const COLUMN = "mx-auto w-full max-w-none px-6";

/** The BYOK refusal envelope from the transport's error text: the 503 body
 *  arrives verbatim as the error message, so the {code, missing} shape
 *  survives to here. Any other text reads as null and keeps the error banner. */
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

/** The provider-key refusal, read like parseModelsRefusal: the 503 body is
 *  the error message verbatim and core's matcher decides, so the wording
 *  cannot drift client-side. */
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
 * The teaching session. Session state lives in useChatSession; the server
 * persists the canonical transcript after every turn.
 *
 * The bottom dock is ONE persistent shell (DockOverlay) whose contents swap
 * (composer ↔ question dock ↔ collapsed bar). It is overlaid on the bottom of
 * the scroller; a transcript spacer reserves its height so content at rest
 * scrolls clear of it.
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
	/** Practice renders no phase chip (no probe→teach arc) and shows a
	 *  Practice tag in the header instead. */
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
	/** A compaction holds the chat's model gate at mount (its
	 * compaction-changed event already fired). The transcript spinner and
	 * send gates key on it. */
	initiallyCompacting?: boolean;
	/** slotsConfigured(server record): decides whether the setup pill shows
	 *  above the composer. The server gate stays the truth. */
	initialConfigured?: boolean;
	initialShowReadingThinking?: boolean;
}) {
	// The reattach stream's settled callback: a stable ref assigned below once
	// syncFromServer exists (a ref, not a closure, so nothing goes stale).
	const reattachSettledRef = useRef<() => void>(() => {});

	// The session hook: the record is native history; the view is derived
	// client-side (core/view.ts projectView); each send is one explicit input
	// event ({chatId, input}); the turn stream is the server's AgentEvent
	// passthrough.
	const { messages, nativeMessages, hasConfirmedConversation, contextTokens, lessonTracking: tracking, tutorPin, send, continueIfOwed, steer, steerQueue, submitAnswer, dismissQuestion, dismissProblem, questionDraft, saveQuestionDraft, setMessages, adoptRecord, status, error, abortTurn, clearError, resumeStream, setReattachSettled } =
		useChatSession({ chatId, initialMessages, initialError, initiallyInFlight });

	const sessionFindScopeRef = useRef<HTMLDivElement | null>(null);
	const scrollContextRef = useRef<StickToBottomContext | null>(null);

	// The reattach settled terminal → the sync-and-continue seam (below).
	setReattachSettled(() => reattachSettledRef.current());

	// A turn running server-side that no live view of ours holds (navigated
	// away mid-turn, or a wake turn discovered mid-session). The reattach
	// stream is the primary channel (resumeStream, the same rendering path as
	// a live turn); this flag is the fallback liveness source: it gates the
	// composer and shows the pre-first-chunk shimmer until the stream attaches
	// or turn-settled arrives.
	const [turnInFlight, setTurnInFlight] = useState(initiallyInFlight ?? false);

	const { titleText, renaming, setRenaming, titleDraft, setTitleDraft, titleInputRef, commitRename } = useSessionRename(chatId, title);

	// Explicit Stop shares the pending-send fence with composer interruptions.
	const abortInFlightTurn = useCallback(() => { void abortTurn(); }, [abortTurn]);
	// Esc: the abort chain opens a confirm popup (for streams and pending
	// questions alike). Both window listeners fire per Esc, so the state gate
	// here, not stopPropagation ordering, keeps the popup's own Esc from
	// chaining. An open overlay claims Esc first and closes itself
	// (escAbortTarget), so it never dismisses the question underneath.
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
			// Dismissing a pending question is silent: the skipped toolResult
			// lands with no turn and no wake; the next plain send wakes the
			// teacher. Mid-turn the question can only dangle because a turn is
			// still running, so the discard also kills that turn; the route
			// parks the dismissal (202) and the settle applies it.
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
			// The practice discard uses the same silent route; the conclude
			// synthesis rides the learner's next input and the composer returns
			// at once. Mid-turn it also kills the running turn (park + settle).
			const problem = activeProblemRef.current;
			if (problem) {
				void dismissProblem(problem.toolCallId);
				if (busyRef.current) abortInFlightTurn();
			}
		},
		[abortInFlightTurn, dismissQuestion, dismissProblem],
	);
	// Mount continuation: if the stored transcript ends with a fulfilled tool
	// (a job result landed while no client was open), resume the lesson. Once
	// per mount; the turn that follows ends in text or a pending question, so
	// no loop. Never while a turn already runs server-side: that would
	// double-run the teacher (the server would 409; the poll resumes instead).
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

	// An active practice problem owns the dock like a pending question (it
	// replaces the composer). Read from the native record, the same fold the
	// tools gate on, not the projected view.
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
	// The attach handoff: once a resumed stream is rendering (status left
	// "ready"), localStream covers busy/shimmer/gates on its own. Keeping
	// turnInFlight set would double-render the shimmer.
	useEffect(() => {
		if (turnInFlight && (status === "submitted" || status === "streaming")) setTurnInFlight(false);
	}, [status, turnInFlight]);

	// Mid-session discovery (jobs poll, handoff watch): a server-side turn
	// exists that none of our views holds — attach to it through the same
	// resume path as mount reattach (live rendering, instant catch-up). The
	// flag stays as the fallback until the stream attaches (watcher above);
	// a newer resume aborts the older request, so discovery ticks re-firing
	// this are harmless.
	const turnInFlightRef = useRef(turnInFlight);
	turnInFlightRef.current = turnInFlight;
	const attachToRunningTurn = useCallback(() => {
		setTurnInFlight(true);
		void resumeStream();
	}, [resumeStream]);

	// The practice dock's one send lane: posts the thinking against the active
	// problem (the agent reads whether it claims an answer). Starts a turn;
	// the dock stays mounted until the agent concludes.
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
	// in cram mode (the default), always, or never. The
	// session's current phase IS the pending question's phase (the
	// teacher's turn ends at the question call).
	const teachingCheck = pending !== null && isTeachingCheck(pending.tool, pending.input, phaseAt3(messages));
	// Cram is chat metadata another window can switch: re-read on
	// chats-changed and reconnects, newest confirmed value first.
	const { cram, begin: beginCramSave } = useLessonCram(chatId, style === "cram");
	// The lesson's stored question type: the Qs chip writes it; record-changed
	// and reconnects re-read it, newest confirmed value first.
	const lessonQuestionType = useLessonQuestionType(chatId, initialQuestionType);
	// A hook, so it runs on every render: never put it behind &&.
	const revealSetting = useGeneralSettings()?.revealQuestions;
	const requiresReveal = teachingCheck && revealsQuestions(revealSetting, cram);

	/* The reading-thinking channel: a draft field for notes while reading the
	 * teaching, mounted while a check waits behind its reveal, sent with the
	 * check answer (or its dismissal) as `readingThinking`. Reset per pending
	 * question. */
	const [showReadingThinking, setShowReadingThinking] = useState(initialShowReadingThinking);
	const [readingThinkingSeed, setReadingThinkingSeed] = useState({ questionId: null as string | null, value: "", revision: 0 });
	const readingThinkingRef = useRef("");
	useReadingThinkingResync(showReadingThinking, readingThinkingRef, setReadingThinkingSeed);
	const { sideTutor, toggleSideTutor, closeSideTutor } = useSideTutor();

	// ⌘T (toggle-user-thinking): sets every user thinking row to one state.
	// Rows default open, so the first press collapses all, the second expands.
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
	 * resets still bump a revision so the local field can sync. The draft
	 * autosaves per chat (components/draft-store.ts). */
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
	/** The last explicitly-sent composer draft: the refusal flow restores it
	 *  into the composer, where it waits for the learner to re-send (Save never
	 *  auto-sends). Auto-continuations (probe answers) never set it, so their
	 *  refusal opens recovery with no replay. */
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

	// The BYOK refusal: a send that gets the 503 models_not_configured
	// envelope opens the setup flow, never the error banner. The gate refuses
	// before the write-ahead persist, so the record is the truth minus the
	// refused send: refetch it (dropping the optimistic orphan), put the draft
	// back in the composer until the learner re-sends it, and open setup.
	useEffect(() => {
		if (!error) return;
		const missing = parseModelsRefusal(error.message);
		// The key refusal: a pinned model whose provider key is gone also
		// restores the draft. With another provider
		// connected, repair belongs to the ordinary current-session picker;
		// otherwise setup derives its exclusive provider/loading stage.
		const keyRefused = parseProviderKeyRefusal(error.message);
		if (!missing && !keyRefused) return; // a real error keeps the honest banner
		// ORDER MATTERS: clearError() flips this effect's own dep (`error`) and
		// would cancel the work below, so the banner dismiss, draft restore
		// and dialog open all land together after the record refetch.
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
		// (setMessages/clearError are stable per session; the flow keys on
		//  [error, chatId].)
	}, [error, chatId]);
	// Tab cycles the chat's fields: reading-thinking → the active dock's field
	// → the composer, in visual order, forward-only with wrap; Tab from
	// anywhere else focuses the first live field. Gathered from the live DOM at
	// event time because the docks mount and unmount (refs would go stale).
	// The quiz dock's rows↔thinking claim never reaches here.
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
	// Voice dictation: finals append at the end of the current text (the page
	// owns the separator).
	const dictation = useDictation({
		// Ref-first (see textRef): the join is computed from the mirror so a
		// send resuming after `await finish()` reads the dictated tail.
		append: (t) => applyText(joinDictation(textRef.current, t)),
	});
	/* When a dictation run ends, the composer takes focus (the hands are on
	 * the keyboard from the stop). Falling edge of `active` only, and only the
	 * composer: with a question pending the Composer is unmounted, the ref is
	 * null, and the thinking field is left alone. */
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

	// Send gating. Jobs never gate the composer (contracts.ts "THE ASYNC
	// PROTOCOL" §4): job tools ack mid-turn and the wake pipeline queues steers
	// until the turn ends. A turn in flight doesn't gate it either: Enter
	// steers the running turn (the queue above the composer). A pending
	// question or active problem owns the dock instead. A live dictation keeps
	// the composer sendable: the spoken text is still in the run's buffer, so
	// Enter must reach the finish-first send (see onSend); with nothing said
	// the send is a no-op. `compacting` tracks compaction-changed; the send
	// paths, canSend and the docks gate on it (the server's registry mutex is
	// the real gate; this is the affordance).
	const [compacting, setCompacting] = useState(initiallyCompacting);
	// A failed model response: Retry keeps the saved input and completed
	// work, without another learner message. Offered from
	// "error" too: a dropped stream leaves the model there, and send()
	// recovers from it. Later compaction requires new input instead.
	const retryable = (status === "ready" || status === "error") && !busy && !compacting && endsInFailedTurn(nativeMessages);
	const retryFailedTurn = () => retryFailedResponse(send, draftRef);
	const sendAllowed = !pending && !activeProblem && !compacting;

	/* The practice pause between problems: practice kind, nothing active or
	 * in flight, and at least one problem already posed (a fresh session owes
	 * its opening turn, not the move-on). Enter-on-empty and the Next chip
	 * both key on it. */
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

	/* Enter from anywhere moves on: the window-level Enter (typing surfaces
	 * and buttons keep their own lane, so no double fire) works without
	 * composer focus. sendNext self-guards on nextReady, so the listener is
	 * inert outside the pause, when the dock-mounted listeners are gone. */
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
			// landing in the record leaves the agent owing a continuation (the
			// record ends on unconsumed results, no question, nothing running).
			// The model's own state also guards retained/live failures: a sync
			// must never automatically replace a reply that failed to save.
			continueIfOwed(record.messages);
			return true;
		} catch { return false; /* retain the confirmed view on a transient read failure */ }
	}, [chatId, setMessages, continueIfOwed]);

	// The settled terminal's other half: the reattach stream resolved
	// turn-settled, so no turn runs and the record is current. Drop the
	// fallback busy state and adopt the record (its continuation check fires
	// any owed next turn, as the poll's settle branch does).
	reattachSettledRef.current = () => {
		setTurnInFlight(false);
		void syncFromServer();
	};

	// ── Append-only record adoption ──
	// Content written into the record server-side (sub-agent artifacts, abort
	// notes) must show the moment it persists, mid-turn included. A full
	// snapshot sync mid-stream would collide with the streaming tail
	// (duplicate message ids), so this adoption is append-only (adoptRecord):
	// insert the record's new ids in canonical order, never rewrite a local
	// one, keep the in-flight tail last. The full syncFromServer stays the net
	// at idle (reorder, plan blocks, turns).
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

	// The live plan popup: opened by the top-bar plan chip and, through the
	// session-overlay context, by every plan control below it (transcript
	// plan blocks, the dock band's marginalia, the progress card's diagram).
	const [planOpen, setPlanOpen] = useState(false);
	const retryQuestion = useCallback((malformed: QuestionCall) => {
		draftRef.current = null;
		void send({ type: "retry-question", messageId: malformed.messageId, contentIndex: malformed.contentIndex, toolCallId: malformed.toolCallId });
	}, [send]);
	// Real plan presence gates the marginalia's clickable flank: a JSX element
	// is always truthy, so gating on the node alone would mount an invisible,
	// clickable button whenever a question is pending with no plan yet.
	const hasPlan = useMemo(() => planExists(messages), [messages]);
	// The coverage ring's refresh tick: bumped at turn settle, when this
	// session's uncovered mass changes.
	const [coverageTick, setCoverageTick] = useState(0);
	// The mermaid focus: md-blocks' expand button registers the chart source
	// here. The overlay and the plan popup mount inside the session-area div
	// (session-scoped), so the drag bar stays usable while a focus is open.
	const [mermaidFocus, setMermaidFocus] = useState<string | null>(null);
	// Figure focus: the figure card's fullscreen button. Same overlay shell as
	// mermaid, carrying the raw svg and the card's invert state.
	const [figureFocus, setFigureFocus] = useState<{ svg: string; inverted: boolean } | null>(null);
	// Stable, so a Chat render never re-renders the memoized transcript's
	// overlay consumers (plan blocks, mermaid and figure cards).
	const sessionOverlay = useMemo(() => ({
		openMermaid: setMermaidFocus,
		openFigure: (svg: string, inverted: boolean) => setFigureFocus({ svg, inverted }),
		openPlan: () => setPlanOpen(true),
	}), []);

	// Overlay mirrors for the layered-Esc gate: the lh:kbd-abort-turn handler
	// reads these at event time.
	const mermaidFocusRef = useRef(mermaidFocus);
	mermaidFocusRef.current = mermaidFocus;
	// The figure focus shares the mermaid layer in the Esc gate: the overlay
	// claims Esc itself at the document level; the window chain stays out.
	const figureFocusRef = useRef(figureFocus);
	figureFocusRef.current = figureFocus;
	const planOpenRef = useRef(planOpen);
	planOpenRef.current = planOpen;
	const setupOpenRef = useRef(setupOpen);
	setupOpenRef.current = setupOpen;
	// The session's live plan (drives the top-bar chip; the marginalia
	// derives its own from the same transcript).
	const planTree = useMemo(() => latestTree(messages), [messages]);
	// The lesson-tracking card: the problem set and mistake log, derived by the
	// session model from the native record and live executions (the tracking
	// tools never render in the transcript; core/lesson-tracking.ts), plus a
	// teach lesson's plan steps with their check scores (core/plan-progress.ts;
	// never in cram or practice). The chip shows while any section exists.
	const planProgress = useMemo(() => lessonPlanProgress(planTree, messages, { cram, practice: kind === "practice" }), [planTree, messages, cram, kind]);
	const hasTracking = hasLessonTracking(tracking) || planProgress !== null;
	const trackerCard = useLessonTrackerShown();
	// "Practice weak spots": the card's button opens a new practice session in
	// this lesson's project, seeded with its weak spots.
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
	// An open pin drawer covers the card's corner: the card steps aside until
	// the drawer closes, and the PROGRESS chip closes the drawer to bring it back.
	const drawerOpen = pinned.escState.drawer === "open";
	const trackerShown = pinned.docked ? progressOverPin : trackerCard.shown && !drawerOpen;
	// The plan diagram goes under the card's plan list when the card has room
	// for it, else to the dock band's flank — never both; a docked pin hides it.
	const [planInCard, setPlanInCard] = useState(false);
	const planDiagram = hasPlan && !(pinned.docked && !progressOverPin) ? <PlanMarginalia messages={messages} /> : undefined;
	const toggleTracker = pinned.docked ? () => setProgressOverPin((v) => !v) : drawerOpen ? pinned.toggleDrawer : trackerCard.toggle;
	// While the card shows on a session area wide enough for both, the
	// transcript column keeps clear of it.
	const trackerRoom = lessonTrackerRoom(hasTracking && trackerCard.shown && !pinned.docked);

	// ── Session usage (the stats bar) ──
	// The record's turns log and the server's read-time pricing projection.
	// Seeded once on mount (the page doesn't carry turns),
	// refreshed when the local stream settles (each turn appends to the log
	// server-side), and kept fresh by syncFromServer whenever it already
	// fetches the record. No turns yet → the bar renders "—" everywhere.
	const [turns, setTurns] = useState<TurnUsage[]>([]);
	const [pricing, setPricing] = useState<SessionPricing | undefined>();
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
		// Updated on every path, so dep churn never re-fires the transition.
		prevStatusRef.current = status;
		if (!transitioned) return;
		// The coverage ring re-reads at turn settle; its own poll handles runs.
		setCoverageTick((t) => t + 1);
		// Canonization: turn-settled for our own turn arrives while the stream
		// is still open (endTurn emits before the response terminates), so the
		// handler below only flags it and this flip consumes the flag. The
		// record reflects durable truth (a failed settlement keeps its notice,
		// not its unsaved reply); replacing the view absorbs the tail's
		// streamed c_-id copies into base under their server ids, so the next
		// send never renders them twice. A wake can't be missed: it fires only
		// after the idle gates + grace (≥750ms past this flip), so its
		// turn-started event lands on an idle, canonical view.
		if (settleAnnouncedRef.current) {
			settleAnnouncedRef.current = false;
			void syncFromServer().then(ok => { if (!ok) void syncTurns(); });
		} else void syncTurns();
	}, [status, syncTurns, syncFromServer]);

	// A stream that died mid-flight (network): the server turn runs on behind
	// the error banner, so re-enter the in-flight state (turn-settled adopts
	// the record) instead of leaving the session blind until the next send's
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
	// One fetch of /api/jobs drives every job surface (transcript dispatch
	// cards, the sub-agents panel) and re-syncs the transcript once when a job
	// settles. The store announces every job write on the events channel; the
	// view fetches on mount, per jobs-changed (trailing 250ms debounce: a
	// sub-agent run writes activity-line bursts), and on channel resync.
	//
	// A settle doesn't imply the record is complete: continuation coalescing
	// flips the job done at claim time, while the learner's own answer turn
	// may still be streaming (and a settle can race another job's wake turn).
	// A full sync mid-stream would collide with the streaming tail (duplicate
	// message ids), so a settle during a busy turn defers the sync to the next
	// idle fetch.
	const [jobs, setJobs] = useState<JobRecord[]>([]);
	const localStreamRef = useRef(false);
	localStreamRef.current = localStream;
	const jobStatusRef = useRef<Map<string, string>>(new Map());
	// A settle seen during a busy turn — the sync is owed, not dropped.
	const pendingSyncRef = useRef(false);
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
			// Turn discovery belongs to turn-started; turnInFlight is read above
			// only for the settle logic's idle check.
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

	// ── Server-initiated turn discovery ──
	// Every turn this chat runs is announced on the events channel: the
	// probe→teach handoff, a job wake, another tab's send, the missed-on-mount
	// case. Handlers read refs, not closure state: events fire between
	// renders, and a ref holds the live value at event time.
	const statusRef = useRef(status);
	statusRef.current = status;
	/** turn-settled arrived for our own turn, so the record is durable (endTurn
	 * fires only after persistTurn); the ready flip consumes this flag to
	 * canonize the view onto the record (the settle effect above). */
	const settleAnnouncedRef = useRef(false);
	useServerEvent("turn-started", (p) => {
		// Known non-issue: beginTurn emits before registerTurn in the same
		// synchronous request flow; a GET /stream inside that sub-ms window
		// gets a settled response. No round-trip can win that race, and the
		// eventual turn-settled heals it. Do not engineer around it.
		if (p.chatId !== chatId) return;
		if (localStreamRef.current) return; // our OWN turn — the 409-race guard
		if (turnInFlightRef.current) return; // already attached
		attachToRunningTurn();
	});
	useServerEvent("turn-settled", (p) => {
		if (p.chatId !== chatId) return;
		if (localStreamRef.current) {
			// Our own [DONE] path owns the busy settle, but the event still
			// matters: it guarantees the record is durable and reliably beats
			// [DONE]. Flag it; the ready flip canonizes the view onto the record.
			// (If [DONE] won instead, the fully-idle branch below already synced.)
			settleAnnouncedRef.current = true;
			return;
		}
		if (turnInFlightRef.current) {
			// The attached stream's terminal frame owns the normal settle;
			// syncing here would swap a stale snapshot mid-stream (see the jobs
			// fetch above). Only the error case heals: the attached stream died,
			// and the settle says the record is now durable.
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
		// The background summary after a settle: while it runs, sends gate
		// (the next turn's server-side ensureCompacted awaits it anyway; this
		// keeps the affordance honest). On finish, record-changed (emitted by
		// the compaction write) carries the marker in.
		if (p.chatId !== chatId) return;
		setCompacting(p.running);
	});
	useServerEvent("record-changed", (p) => {
		// A write with no turn (e.g. the silent dismissal): only the record
		// moved. Other tabs and post-error windows adopt; our own dismissal
		// already rendered its optimistic append, and syncing again is
		// harmless (adoption swaps local ids for the server's). Busy states
		// ignore it: a running turn owns the view, and the write is
		// 409-guarded against that anyway.
		if (p.chatId !== chatId) return;
		if (localStreamRef.current || turnInFlightRef.current) return;
		void syncFromServer();
	});

	const onSend = () => {
		if (pending || compacting) return;
		/* Finish dictation first: a learner who talks right through Enter must
		 * not lose the tail. Stop the run, let the last finals land, then send
		 * the ref value (the flush lands via setState, invisible to this
		 * closure). */
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
		<SessionOverlayContext.Provider value={sessionOverlay}>
		<JobsContext.Provider value={jobs}>
		<PinnedVisualContext.Provider value={pinned.context}>
		{/* The session surface: the transcript column (header + scroller) and
		    the side tutor as full-height siblings. The dock overlays the column
		    bottom (outside the scroller); a spacer in the transcript reserves
		    its height. */}
		<div className="relative flex lh-h-screen">
			<div className="flex min-w-0 flex-1 flex-col">
				{/* The top bar: in flow above the scroller. Fixed 60px height, not
				    padding: the sidebar toggle renders only while the sidebar is
				    closed, and an auto-height row would collapse without it. 60px
				    also equals the sidebar's wordmark band, so the two bottom
				    borders form one line across the app. */}
				<TopBar
					// While renaming, the bar is not a drag surface: app-region:drag
					// would eat the mousedown, so click-to-escape (below) could
					// never fire.
					drag={!renaming}
					onMouseDown={(e) => {
						// Any mousedown outside the input blurs it, running the onBlur
						// commit. The input is shrink-to-fit (field-sizing), so the
						// rest of the bar is click-to-exit.
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
									// stopPropagation claims the Esc: closing rename
									// must not also abort a turn.
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
							className="lh-no-drag -mx-1.5 min-w-[8ch] shrink cursor-text truncate rounded-md px-1.5 text-left font-title text-3xl tracking-tight transition-colors hover:bg-accent"
						>
							{titleText}
							</button>
						</Hint>
							{/* flex-1 spacer: keeps the chips at the right edge AND stays a
							    drag surface (no carve-out) — the freed bar is grippable. */}
							<div className="min-w-4 flex-1" aria-hidden="true" />
					</>
					)}
					{/* The chip row scrolls sideways when the bar is too narrow (phone
					    widths) instead of widening the page; the extraction ring and
					    phase tag stay outside it — the ring's popover would clip. */}
					<div className="flex min-w-0 items-center gap-3 overflow-x-auto [scrollbar-width:none]">
					<Hint label="Temporary side tutor" action="toggle-side-tutor" side="bottom">
						<button type="button" aria-label="Open side tutor" aria-expanded={sideTutor !== null} onClick={toggleSideTutor} className="lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground"><MessageCircleQuestionIcon className="size-3.5 text-primary" aria-hidden />Side tutor</button>
					</Hint>
					{/* The plan chip opens the full-DAG popup at every width; the
					    marginalia is the wide-screen glance view. */}
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
					{kind !== "practice" && <CramToggle chatId={chatId} on={cram} beginSave={beginCramSave} />}
					{/* The lesson's question type: the teacher's tools, so never for
					    practice and not while the prober runs. */}
					{showsQuestionTypeChip(kind, phases.at(-1) ?? "probe") && (
						<QuestionTypeChip chatId={chatId} stored={lessonQuestionType.questionType} cram={cram} initialAgentTools={agentTools} beginSave={lessonQuestionType.begin} />
					)}
					</div>
					{/* The extraction ring: fills with uncovered vs the chunk
					    threshold, pulses while a run is in flight, vanishes when the
					    graph is off; click for the numbers. Hidden in practice, which
					    never extracts. */}
					{kind !== "practice" && <CoverageRing chatId={chatId} refreshKey={coverageTick} />}
					{/* Practice has no phase arc: a Practice tag replaces the chip. */}
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
							/>

							{/* Compaction: shown while the summarizer holds the model gate.
							    Never coexists with the Thinking placeholder (the gate sits
							    before beginTurn; the settle summary runs after endTurn). */}
							{compacting && (
								<span className="flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
									<BrailleSpinner label="Compacting context" />
									<Shimmer duration={1}>COMPACTING CONTEXT…</Shimmer>
								</span>
							)}
							{/* The Thinking placeholder: from the instant of any action
							    that produces tokens (status flips to submitted
							    synchronously) until the turn's first applied event, where
							    an arrived-but-empty message renders the thinking row
							    (view.ts projects one empty reasoning part). So submitted ⟺
							    placeholder and streaming ⟺ a rendered row. Protocol events
							    (agent_start) apply nothing, so it covers the whole
							    provider-connect gap. turnInFlight is the same state entered
							    by external discovery. */}
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
						    at-rest transcript content scrolls fully clear of the
						    overlay. The first layout effect reports before paint. */}
						<div aria-hidden data-testid="dock-spacer" style={{ height: dockReserve }} />
				</ConversationContent>
				{/* The dock: an overlay sibling of the scroller (the
				    use-stick-to-bottom pattern). Its scroll-down button is anchored
				    to the dock block's top edge, so it rides every height change
				    and never overlaps the composer. */}
				<DockOverlay
					pending={pending}
					initialQuestionDraft={pending ? questionDraft(pending.key)?.form : undefined}
					onSaveQuestionDraft={(form) => { if (pending) saveQuestionDraft(pending.key, { form }); }}
					practice={activeProblem}
					compactionRunning={compacting}
					onSubmitThinking={submitThinking}
					plan={planInCard ? undefined : planDiagram}
					teachingCheck={teachingCheck}
					requiresReveal={requiresReveal}
					showReadingThinking={showReadingThinking}
					readingThinking={readingThinkingSeed.value}
					readingThinkingRevision={readingThinkingSeed.revision}
					onReadingThinking={applyReadingThinking}
					phase={phases.at(-1) ?? "probe"}
					footer={
						<StatsBar
							turns={turns}
							contextTokens={contextTokens}
							cliContextWindow={cliContextWindowOf(nativeMessages)}
							pricing={pricing}
							dictationSlot={<DictationBar dictation={dictation} />}
							chatId={chatId}
							onModelChange={setSelectedModel}
						/>
					}
					onReserve={setDockReserve}
					room={trackerRoom.dock}
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
							// Stop aborts any in-flight turn, reattached and wake turns
							// included: the abort channel kills it server-side (stop()
							// alone would only detach our view).
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
							// In the practice pause the placeholder is the hint, shown
							// exactly where Enter-on-empty applies.
							nextProblem={nextReady}
							onNext={sendNext}
							placeholder={nextReady ? "Ask anything, or press Enter for the next one." : undefined}
						/>
					}
					onSubmitAnswer={(output) => {
						if (!pending) return;
						// The answer is the question call's tool result: one input
						// event, one turn. The hook appends the optimistic graded result
						// (the AnsweredCard shows at once), the server persists it
						// before the turn, and the teacher's reaction streams below.
						// Dismissals use the same callback (QuestionAnswerData.dismissed).
						// The reading-thinking draft rides along: the check answer is
						// its only carrier.
						saveQuestionDraft(pending.key, { readingThinking: readingThinkingRef.current });
						const reading = readingThinkingRef.current.trim() || undefined;
						// The pending-id effect clears this only when the question
						// actually leaves. An offline preflight keeps the draft visible.
						submitAnswer(pending.toolCallId, reading ? { ...output, readingThinking: reading } : output, pending.key);
					}}
				/>
				</Conversation>
				{/* The pinned demo/diagram's docked column (the card itself stays
				    in its transcript row, restyled over this column). */}
				{pinned.dockColumn}
				{/* The tracking card: top-right over the transcript, below the
				    session-scoped focuses (z-40) and clear of the dock. */}
				{hasTracking && trackerShown && <LessonTrackerCard tracking={tracking} plan={planProgress} bottomReserve={Math.max(0, dockReserve - GRADIENT_H)} onPracticeWeakSpots={configured && !zeroKeys ? practiceWeakSpots : undefined} planView={pending ? planDiagram : undefined} onPlanViewPlaced={setPlanInCard} />}
				{pinned.drawerTab}

				{/* The session-scoped focuses: absolute inset-0 siblings of the
				    scroller inside the session area, so the top bar stays usable and
				    draggable while a focus is open. */}
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
		</SessionOverlayContext.Provider>
		{/* The BYOK setup flow: one mount serves the setup CTA, the
		    refused-send interception, and the job cards' deep link. Save and Esc
		    both leave the draft in the composer; nothing auto-sends (the gate is
		    the server, not this modal). */}
		<SetupDialog
			open={setupOpen}
			onClose={() => setSetupOpen(false)}
			onDone={() => {
				setSetupOpen(false);
				// Save only saves: the refused draft is already back in the
				// composer, and the learner sends it themselves.
			}}
		/>
		</ChatActionsContext.Provider>
	);
}

/** Layered Esc: an open overlay claims Esc, closing itself, before the abort
 *  chain may open its confirm, so a mermaid focus, the plan popup, or the
 *  setup dialog over a pending question never dismisses the question
 *  underneath. Priority is stacking order: the abort confirm (claims via its
 *  own dialog), the session overlays, setup (self-closing; the gate must
 *  only not fire), then the abort chain proper (question, problem, turn). */
export type EscAbortTarget = "mermaid" | "pin-expanded" | "plan" | "setup" | "pin-drawer" | "question" | "problem" | "turn" | null;

/**
 * Does the opening topic still owe its first send? The topic is the server's
 * ?prompt= or the sessionStorage stash. The gate is "no user/assistant
 * message yet", not emptiness: a session started with map picks carries a
 * graph-context marker as message[0], which must not swallow the first send.
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
	/** An active practice problem: Esc opens the discard confirm, below a
	 *  pending question (they never coexist, but the layering stays strict)
	 *  and above the turn abort. */
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
