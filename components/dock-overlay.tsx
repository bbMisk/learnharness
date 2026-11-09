"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { opensWaitingCheck } from "@/components/waiting-check-key";
import { openModal } from "@/components/open-modal";
import { focusComposer } from "@/components/focus-return";
import { Hint } from "@/components/ui/hint";
import { useSessionOverlay } from "@/components/session-overlay";
import { ConversationScrollButton } from "@/components/ai-elements/conversation";
import { dockStateKey } from "@/components/dock-state-key";
import { forwardDockWheel, useDockHeight } from "@/components/dock-height";
import { QueuedSteersBody, type QueuedSteerLine } from "@/components/queued-steers";
import { finishDictation } from "@/components/dictation";
import { QuestionDock } from "@/components/question-dock";
import { PracticeDock } from "@/components/practice-dock";
import { MARGIN_MIN_W, dockFlank, measureDockFlank, type DockFlank } from "@/components/dock-flank";
import { rememberRevealed, wasRevealed } from "@/components/revealed-questions";
import { useHydrated } from "@/components/use-hydrated";
import { rememberDockFolded, restoresReadingPosition, savedDockReserve } from "@/components/session-navigation";
import { ReadingThinkingField } from "@/components/reading-thinking";
import type { pendingQuestionOf, Phase3, QuestionAnswerData, QuestionFormDraft } from "@/src/core";

/** The dock column: narrower than the transcript, ~46rem centered. */
const DOCK = "mx-auto w-full max-w-[46rem] px-4";
// The plan marginalia's geometry lives in components/dock-flank.ts: the bare
// diagram sits in the dock band's right flank while a question owns the
// band, fading below MARGIN_MIN_W.
// The dock overlay's gradient band (h-24), part of the reserved tail.
export const GRADIENT_H = 96;
// Fold thresholds: pixel distance from the bottom (position, not velocity).
// Leave the bottom and the box folds (visual only); reach it again and it
// re-opens. 96 tolerates a small peek upward; the dead band vs EXPAND_DIST
// absorbs trackpad drift.
const COLLAPSE_DIST = 96;
const EXPAND_DIST = 16;

/** useLayoutEffect that is silent during SSR (client components still render on the server in Next). */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * How a teach-phase question arrives: collapsed behind the reveal button when
 * it follows the composer (the learner reads the teaching first), but open
 * when it follows another question (a queued parallel check), since the
 * reading already happened.
 */
export function revealArrival(wasQuestion: boolean): { expanded: boolean; revealed: boolean } {
	return wasQuestion ? { expanded: true, revealed: true } : { expanded: false, revealed: false };
}

/**
 * A question's arrival state when no reveal applies: open iff the learner is
 * at the bottom following along; scrolled up in history, it arrives as the
 * collapsed bar. Decided during render, so no stale-open frame paints first.
 */
export function questionArrivalExpanded(isAtBottom: boolean): boolean {
	return isAtBottom;
}

/**
 * The geometry mute's growth rule: a reserve growth while a question is
 * pending is the dock stretching (e.g. a dictation flush landing many lines).
 * The spacer lands in that commit and the smooth catch-up lags by exactly the
 * growth; that lag is our own motion, not the learner leaving, so the fold
 * machine ignores scroll events for the mute window after. Shrinks never
 * stamp: muting them would swallow the at-bottom re-expand and leave the box
 * stuck collapsed.
 */
export function shouldStampGeometryMute(nextH: number, prevH: number, pending: boolean): boolean {
	return pending && nextH > prevH + 1;
}

/**
 * The floating dock: ONE persistent shell, overlaid at the bottom of the
 * column (absolute, a sibling of the scroller: the use-stick-to-bottom
 * pattern). Contents swap between the composer and the question/practice
 * dock; the shell height morphs between variants (WAAPI, quick). A spacer at
 * the end of the transcript (rendered by Chat from onReserve reports) holds
 * the dock's flow-space, so at-rest content scrolls fully clear of it.
 *
 * Why an overlay: an in-flow dock is scroll geometry, so folding it would
 * shrink the scroll content and the browser's scroll clamp would pin the
 * learner back and re-expand it (oscillation). Out of the flow, the fold is
 * visual only: it fires as soon as the learner leaves the bottom, and the
 * reserved tail only ever grows while a question is open (a shrinking tail
 * would reintroduce the clamp).
 *
 * Collapse: scroll up past COLLAPSE_DIST and the dock folds into a slim bar;
 * click it (or scroll back to the bottom) to re-expand. The question form
 * stays MOUNTED while collapsed (hidden, not unmounted) so a half-made
 * selection survives.
 */
export function DockOverlay({
	pending,
	initialQuestionDraft,
	onSaveQuestionDraft,
	practice,
	compactionRunning,
	onSubmitThinking,
	teachingCheck,
	requiresReveal,
	showReadingThinking,
	readingThinking,
	readingThinkingRevision,
	onReadingThinking,
	phase,
	composer,
	onSubmitAnswer,
	footer,
	onReserve,
	room,
	plan,
	dictationCancel,
	setupCta,
	queuedSteers,
	checkEscRef,
}: {
	pending: ReturnType<typeof pendingQuestionOf>;
	initialQuestionDraft?: QuestionFormDraft;
	onSaveQuestionDraft: (draft: QuestionFormDraft) => void;
	/** Compaction running for this chat: the docks' submit affordance gate
	 *  (the server's registry is the real one). */
	compactionRunning: boolean;
	/** The active practice problem {toolCallId, input}: owns the dock like a
	 *  pending question (the composer is replaced); null in teaching sessions. */
	practice: { toolCallId: string; input: unknown } | null;
	/** The practice dock's send lane. */
	onSubmitThinking: (text: string) => void;
	/** Teach-phase check: keeps the optional reading-notes field. */
	teachingCheck: boolean;
	/** The check arrives collapsed behind the reveal button (Settings → Reveal questions). */
	requiresReveal: boolean;
	showReadingThinking: boolean;
	/** The reading-thinking draft, owned by Chat so the submit and dismissal
	 *  seams (outside this overlay) can merge it. */
	readingThinking: string;
	readingThinkingRevision: number;
	onReadingThinking: (v: string) => void;
	/** Session phase at the pending question — scales the thinking field. */
	phase: Phase3;
	composer: React.ReactNode;
	onSubmitAnswer: (output: QuestionAnswerData) => void;
	/** The stats row beneath the composer/question shell (Chat's StatsBar):
	 *  placed here, outside the morphing shell; its behavior is its own. */
	footer: React.ReactNode;
	/** Reports the dock's settled height (block + gradient); Chat's
	 *  dockReserve feeds the transcript's spacer from it. */
	onReserve: (h: number) => void;
	/** The progress card's make-room padding (lessonTrackerRoom's `dock`):
	 *  centres the dock on the narrowed column while the card shows on a wide
	 *  session area; "" otherwise. */
	room: string;
	/** The plan marginalia's content (the bare diagram) — rendered only
	 *  while a question owns the band. Null until a plan exists. */
	plan?: React.ReactNode;
	/** Esc in a pending question's field stops dictation (the strip is the
	 *  stats bar's; the stop belongs to the page-owned hook, threaded down). */
	dictationCancel?: () => void;
	/** The queued-steer indicator's lines, already filtered by
	 *  visibleQueuedSteers (only undrained steers). */
	queuedSteers: QueuedSteerLine[];
	/** The setup CTA (or plan-accept bar) shown above the composer. */
	setupCta?: React.ReactNode;
	/** Chat's layered Esc: holds the collapse while an opened teach check is
	 *  showing, so Esc steps it back to its bar before the dismiss confirm. */
	checkEscRef?: React.RefObject<(() => void) | null>;
}) {
	const { isAtBottom, scrollToBottom, scrollRef } = useStickToBottomContext();
	const overlay = useSessionOverlay();
	// Render-fresh bottom state: the arrival block below reads it during
	// render. Assigned per render like the other refs below.
	const atBottomRef = useRef(isAtBottom);
	atBottomRef.current = isAtBottom;
	// Teach-phase mount (session reload with a pending check): the dock starts
	// as the collapsed invitation too — the check must not pop open on reload —
	// unless the learner already opened it (switched chats and came back).
	// Session storage is read only after hydration, so the first render
	// matches the server's; an opened check then opens in the next render.
	const hydrated = useHydrated();
	const openedBefore = hydrated && wasRevealed(pending?.key ?? null);
	// Coming back to a saved reading position: the question starts folded so
	// it doesn't cover the passage (reaching the bottom opens it as usual).
	// The router's path: during this render the URL may still be the last page's.
	const path = usePathname() ?? (typeof window === "undefined" ? "" : window.location.pathname);
	const [restoring] = useState(() => restoresReadingPosition(path));
	const [expanded, setExpanded] = useState(() => (!requiresReveal || openedBefore) && !restoring);
	const [readingUploading, setReadingUploading] = useState(false);
	// Reveal state: false until the learner opens the invitation. While false,
	// the scroll machine must not auto-expand at the bottom (the learner reads
	// the teaching first). Once revealed, the normal fold rules apply.
	const [revealed, setRevealed] = useState(openedBefore);
	// Tracked in state, not a ref: a ref mutated during a render React later
	// discards would skip the restore on the retry and leave the bar stuck.
	const [seenHydrated, setSeenHydrated] = useState(hydrated);
	if (hydrated !== seenHydrated) {
		setSeenHydrated(hydrated);
		if (openedBefore) {
			setExpanded(true);
			setRevealed(true);
		}
	}
	const revealPending = requiresReveal && !revealed;

	const pendingId = pending?.key ?? null;
	const initialPendingRef = useRef(pendingId);

	// Question arrival state, applied during render, before the first paint.
	// A stale expanded=true from the previous question would paint one frame
	// of the open question; the dock would measure itself tall and reserve
	// that height for good (the reserve never shrinks while a question is
	// open). Resetting here means the paint measures the bar.
	const prevPendingIdRef = useRef(pendingId);
	if (pendingId !== prevPendingIdRef.current) {
		const wasQuestion = prevPendingIdRef.current !== null;
		prevPendingIdRef.current = pendingId;
		if (pendingId && requiresReveal) {
			const arrival = wasRevealed(pendingId) ? { expanded: true, revealed: true } : revealArrival(wasQuestion);
			if (arrival.revealed) rememberRevealed(pendingId);
			setExpanded(arrival.expanded);
			setRevealed(arrival.revealed);
		} else if (pendingId) {
			// Probe arrival: open iff following at the bottom, painted in this
			// render (no stale-open frame).
			setExpanded(questionArrivalExpanded(atBottomRef.current));
		}
	}

	// A new question mid-session: the open/closed state is decided during
	// render above; this effect only owns the reveal scroll for the at-bottom
	// arrival, under the same fold suppression as the teach reveal (otherwise
	// the arrival's growth out-runs the scroll catch-up and the fold machine
	// reads the lag as the learner leaving). On session mount the dock starts
	// in its initial state: no scroll, no morph.
	useEffect(() => {
		holdFoldRef.current = false;
		if (pendingId !== initialPendingRef.current) restoreHoldRef.current = false;
		if (!pendingId || pendingId === initialPendingRef.current) return;
		if (!requiresReveal && atBottomRef.current) void suppressFoldDuringReveal();
		// fire only when a NEW question lands
	}, [pendingId]);

	// ── Fold machine (position, not velocity) ──
	// The dock is an overlay: folding is visual-only and scroll geometry never
	// moves, so the thresholds can hug the bottom. Leave it → fold; reach it
	// again → re-open. The dead band keeps trackpad drift from chattering.
	const expandedRef = useRef(expanded);
	expandedRef.current = expanded;
	// Dock ownership (the fold machine, the reserve immunity, the arrival
	// states): a pending question OR an active practice problem — either
	// replaces the composer and owns the band.
	const pendingRef = useRef(!!pending || !!practice);
	pendingRef.current = !!pending || !!practice;
	const requiresRevealRef = useRef(requiresReveal);
	requiresRevealRef.current = requiresReveal;
	const revealedRef = useRef(revealed);
	revealedRef.current = revealed;
	// Leaving the page: a folded question comes back folded.
	useEffect(() => () => rememberDockFolded(path, pendingRef.current && !expandedRef.current), [path]);

	const blockRef = useRef<HTMLDivElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const shellRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const mode = pending
		? `question:${pending.key}`
		: practice
			? `practice:${practice.toolCallId}`
			: "chat";

	// The plan marginalia's flank: from the DOCK container's right edge to the
	// block's right edge, the bare diagram's canvas. A ResizeObserver on the
	// block tracks it live (window resize, sidebar toggle, scrollbar, rewrap),
	// so the fade floor never lags. With the card's make-room padding the
	// flank starts at the shifted dock's edge and ends left of the card's lane
	// (dock-flank.ts); padding changes alter the block's content box, so the
	// observer sees them, and `room` re-runs it too.
	const [flank, setFlank] = useState<DockFlank>(() => dockFlank(0, 0, 0));
	const flankW = flank.width;
	const flankWRef = useRef(0);
	const laneRef = useRef(0);
	// The resize mute: the fold machine ignores scroll events for a beat after
	// a geometry change, because a resize/rewrap re-clamps scrollTop and emits
	// phantom scroll events mid-transient. Width changes stamp here; height
	// growth stamps at the offer (below), since the spacer growing is the
	// phantom-scroll source. Shrinks never stamp: the fold's own morph shrinks
	// the block, and muting that would swallow the at-bottom re-expand.
	const geometryAtRef = useRef(0);
	useIsoLayoutEffect(() => {
		const block = blockRef.current;
		if (!block) return;
		const measure = () => {
			const next = measureDockFlank(block);
			const widthMoved = Math.abs(next.width - flankWRef.current) > 1;
			if (widthMoved || next.lane !== laneRef.current) {
				flankWRef.current = next.width;
				laneRef.current = next.lane;
				setFlank(next);
				if (widthMoved) geometryAtRef.current = Date.now();
			}
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(block);
		return () => ro.disconnect();
	}, [room]);

	// The reserve grows immediately, but never shrinks while a question or
	// practice problem owns the dock: shrinking flow space could pin a nearby
	// learner back to the bottom. Composer mode may give space back.
	const reserveRef = useRef(0);
	// Restored folded: keep the spacer the saved position was measured with.
	const [reserveFloor] = useState(() => (restoring ? savedDockReserve(path) : 0));
	const offer = useCallback((blockH: number) => {
		const next = Math.max(blockH + GRADIENT_H, pendingRef.current ? reserveFloor : 0);
		if (next <= reserveRef.current + 0.5 && pendingRef.current) return;
		// Stamp growth at the source, including child-only field resizes, so
		// stick-to-bottom's catch-up is not mistaken for the learner leaving.
		if (shouldStampGeometryMute(next, reserveRef.current, pendingRef.current)) geometryAtRef.current = Date.now();
		reserveRef.current = next;
		onReserve(next);
	}, [onReserve, reserveFloor]);

	// The overlay must not paint over the scroller's scrollbar: the scroller
	// reserves symmetric gutters (scrollbar-gutter:
	// stable both-edges), so inset the overlay's right edge by the gutter —
	// zero on macOS overlay scrollbars, the real width on classic platforms.
	// Budget the whole solid dock, leaving only its question area flexible.
	// The hook measures natural, visible content before the morph/reserve
	// effect below. Short windows scroll the reading/question/answer body;
	// the stats/model toolbar remains outside that overflow viewport.
	const [sbInset, setSbInset] = useState(0);
	useDockHeight({
		scrollRef, blockRef, viewportRef, bodyRef, shellRef, contentRef,
		expanded, enabled: !!pending || !!practice, mode, onScrollbarInset: setSbInset, onHeight: offer,
	});

	// Growth mute: during a live turn the transcript grows and stick-to-bottom
	// chases it; the transient distance from the bottom must not read as the
	// learner leaving. A ResizeObserver on the scroller's content stamps a
	// mute like the dock's own resizes, so growth frames never fold. Shrinks
	// stamp nothing (muting the fold's own morph would swallow the at-bottom
	// re-expand).
	const growthAtRef = useRef(0);
	useEffect(() => {
		const el = scrollRef.current;
		const content = el?.firstElementChild as HTMLElement | null | undefined;
		if (!el || !content) return;
		let prevH = content.getBoundingClientRect().height;
		// The entry already carries the border-box height; reading the DOM
		// again could force a layout another observer just invalidated.
		const ro = new ResizeObserver(([entry]) => {
			const h = entry!.borderBoxSize[0]!.blockSize;
			if (h > prevH + 0.5) growthAtRef.current = Date.now();
			prevH = Math.max(prevH, h);
		});
		ro.observe(content);
		return () => ro.disconnect();
	}, [scrollRef]);

	// Wheel over the dock must still scroll the transcript: the overlay is a
	// sibling of the scroller, so native scroll chaining stops at it. Internal
	// scrollers (the question area, textarea
	// overflow, the model menus) keep native scrolling, including their own
	// edge chaining; only when nothing under the cursor can take the delta do
	// we forward it to the transcript.
	useEffect(() => {
		const root = blockRef.current;
		const el = scrollRef.current;
		if (!root || !el) return;
		const onWheel = (e: WheelEvent) => forwardDockWheel(e, root, el);
		root.addEventListener("wheel", onWheel, { passive: false });
		return () => root.removeEventListener("wheel", onWheel);
	}, [scrollRef]);

	// Explicit expand (bar click): the smooth scroll to the bottom takes
	// hundreds of ms, during which the position is still legitimately inside
	// the collapse zone — the machine would instantly re-collapse the dock
	// (open → snap shut → reopen at the bottom, the flicker). Suppress the
	// collapse branch until the reveal scroll settles or is interrupted. The
	// probe arrival at the bottom is the same motion and uses the same cover.
	const expandIntentRef = useRef(false);
	const intentTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const suppressFoldDuringReveal = () => {
		expandIntentRef.current = true;
		clearTimeout(intentTimerRef.current);
		intentTimerRef.current = setTimeout(() => {
			expandIntentRef.current = false;
		}, 2000);
		return Promise.resolve(scrollToBottom()).finally(() => {
			clearTimeout(intentTimerRef.current);
			expandIntentRef.current = false;
		});
	};
	// An explicit Esc fold holds against the at-bottom re-open (the reveal
	// scroll may still be landing) until the learner leaves the bottom.
	const holdFoldRef = useRef(false);
	// So does a restored fold, since the page opens at the bottom before the
	// restore lands; but a wheel-down at the bottom still opens it.
	const restoreHoldRef = useRef(restoring);
	const focusCheckRef = useRef(false);
	const expandAndReveal = () => {
		holdFoldRef.current = false;
		setRevealed(true); // the teach-check invitation was accepted
		rememberRevealed(pendingId);
		setExpanded(true);
		focusCheckRef.current = true;
		void suppressFoldDuringReveal();
	};
	// An explicit open moves focus into the check (the bar that held it is
	// gone), unless the learner is typing somewhere.
	useEffect(() => {
		if (!expanded || !focusCheckRef.current) return;
		focusCheckRef.current = false;
		const active = document.activeElement;
		if (active instanceof HTMLElement && active !== document.body && (active.isContentEditable || active.matches("input, textarea"))) return;
		shellRef.current?.querySelector<HTMLElement>('[data-testid="question-dock"]')?.focus({ preventScroll: true });
	}, [expanded]);
	const expandAndRevealRef = useRef(expandAndReveal);
	expandAndRevealRef.current = expandAndReveal;
	// Enter (or Space) opens the waiting check: while a question waits with
	// the dock closed (behind its reveal invitation or folded by scroll),
	// Enter is never dead. Any live dictation finishes first (the flush lands
	// in the reading-thinking field, so nothing is lost), then the check
	// opens. A typing surface or a focused button owns its own Enter; this
	// listener claims only plain focus, where Enter would do nothing.
	useEffect(() => {
		if (!pending || expanded) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (openModal() || !opensWaitingCheck(e, e.target as Element | null)) return;
			// Claimed: the reopen lands in a microtask before the window-level
			// Enter-submits runs, which would then submit the just-opened form.
			e.preventDefault();
			e.stopPropagation();
			void finishDictation().then(() => {
				expandAndRevealRef.current();
			});
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [pending, expanded]);
	const checkCollapsible = !!pending && requiresReveal && expanded;
	const refocusOnFoldRef = useRef(false);
	useEffect(() => {
		if (!checkEscRef || !checkCollapsible) return;
		checkEscRef.current = () => {
			// Focus left in the hidden form would keep its Enter-to-submit:
			// it moves to the visible typing field, if any, once the check folds.
			const active = document.activeElement;
			if (active instanceof HTMLElement && shellRef.current?.contains(active)) {
				active.blur();
				refocusOnFoldRef.current = true;
			}
			holdFoldRef.current = true;
			setExpanded(false);
		};
		return () => { checkEscRef.current = null; };
	}, [checkEscRef, checkCollapsible]);
	useEffect(() => {
		if (expanded || !refocusOnFoldRef.current) return;
		refocusOnFoldRef.current = false;
		if (document.activeElement === document.body) focusComposer();
	}, [expanded]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onScroll = () => {
			if (!pendingRef.current) return;
			// Resize mute: a geometry change re-clamps scrollTop and the browser
			// emits the clamp as a scroll event. Real scrolling resumes after the
			// brief mute window.
			if (Date.now() - geometryAtRef.current < 400) return;
			// Growth mute: the transcript growing under a live turn is not the
			// learner leaving.
			if (Date.now() - growthAtRef.current < 400) return;
			const d = el.scrollHeight - el.clientHeight - el.scrollTop;
			if (expandedRef.current) {
				// A fold needs the distance AND stick-to-bottom agreeing the
				// learner left the bottom: distance alone trips on stick-to-bottom's
				// catch-up transients.
				if (d > COLLAPSE_DIST && !expandIntentRef.current && !atBottomRef.current) setExpanded(false);
			} else if (holdFoldRef.current || restoreHoldRef.current) {
				if (d > COLLAPSE_DIST && !expandIntentRef.current) holdFoldRef.current = restoreHoldRef.current = false;
			} else if (d < EXPAND_DIST) {
				// Teach checks stay collapsed until the learner opens them: the
				// at-bottom auto-expand would pop the form over the teaching.
				if (requiresRevealRef.current && !revealedRef.current) return;
				setExpanded(true);
				void scrollToBottom();
			}
		};
		// Wheeling down while already at the bottom emits no scroll event (and
		// one muted above may have been the last): it re-opens a folded check too.
		const onWheel = (e: WheelEvent) => {
			if (e.deltaY <= 0 || expandedRef.current || holdFoldRef.current || !pendingRef.current) return;
			if (requiresRevealRef.current && !revealedRef.current) return;
			if (el.scrollHeight - el.clientHeight - el.scrollTop >= EXPAND_DIST) return;
			setExpanded(true);
			void scrollToBottom();
		};
		const block = blockRef.current;
		el.addEventListener("scroll", onScroll, { passive: true });
		el.addEventListener("wheel", onWheel, { passive: true });
		block?.addEventListener("wheel", onWheel, { passive: true });
		return () => {
			el.removeEventListener("scroll", onScroll);
			el.removeEventListener("wheel", onWheel);
			block?.removeEventListener("wheel", onWheel);
		};
	}, [scrollRef, scrollToBottom]);

	// The settled block height (gradient excluded), offered to the spacer.
	// Only ever called with NATURAL heights — never the animated mid-morph
	// value (the iso effect's getAnimations guard wraps every call).
	const measureBlock = () => {
		const b = blockRef.current;
		if (b) offer(b.getBoundingClientRect().height);
	};

	// The opening variant of a session appears instantly — the fade/rise is
	// reserved for mid-session transitions.
	const initialModeRef = useRef(mode);

	// Height morph: animate the shell from its previous height to its new one
	// whenever the variant (chat ↔ question ↔ collapsed bar) changes. Typing
	// growth keeps the same stateKey and is NOT animated.
	// The fold's content fade: a WAAPI fade/rise on the bar↔form toggle, with
	// no remount, so the question form's state survives.
	const prevExpandedForFadeRef = useRef(expanded);
	useIsoLayoutEffect(() => {
		if (prevExpandedForFadeRef.current === expanded) return;
		prevExpandedForFadeRef.current = expanded;
		contentRef.current?.animate(
			[{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }],
			{ duration: 160, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
		);
	}, [expanded]);
	// The height-morph key (components/dock-state-key.ts): the expanded term
	// (the fold) applies to every docked variant, question and practice.
	// Typing growth keeps the key and never animates; fold/unfold morphs.
	const stateKey = dockStateKey(mode, !!pending || !!practice, expanded);
	const prevRef = useRef<{ key: string; height: number } | null>(null);
	useIsoLayoutEffect(() => {
		const el = shellRef.current;
		if (!el) return;
		const p = prevRef.current;
		if (p && p.key === stateKey) {
			// Same variant: keep the settled height fresh, but never measure while
			// a morph is in flight — getBoundingClientRect would read the ANIMATED
			// value and corrupt the start height of the next morph.
			if (el.getAnimations().length === 0) {
				const h = el.getBoundingClientRect().height;
				p.height = h;
				measureBlock(); // typing growth → the spacer grows with the box
			}
			return;
		}
		el.getAnimations().forEach((a) => a.cancel()); // flush to natural height before measuring
		const h = el.getBoundingClientRect().height;
		// Variant change → re-reserve. Growth applies instantly; a drop (the
		// fold, or question → composer) is filtered by the offer policy.
		measureBlock();
		if (p && Math.abs(p.height - h) > 1) {
			el.animate([{ height: `${p.height}px` }, { height: `${h}px` }], {
				duration: 120,
				easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
			});
		}
		prevRef.current = { key: stateKey, height: h };
	});

	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ right: sbInset }}>
			<div className="h-24 bg-gradient-to-t from-background via-background/85 to-transparent" />
			<div ref={blockRef} data-testid="dock-block" className={`relative bg-background pb-5 ${room}`}>
				<div className={DOCK}>
					<div ref={viewportRef} data-dock-viewport="" className="pointer-events-auto">
					<div ref={bodyRef}>
					{setupCta}
					{/* The queued-steer indicator: quiet one-liners above the shell,
					    right-aligned to where its corner rounding starts. A line goes
					    away when its card lands (visibleQueuedSteers). */}
					<QueuedSteersBody steers={queuedSteers} />
					{/* The reading-thinking field: mounted while a teach-phase check
					    waits. It claims dictated speech until the learner reveals a
					    collapsed check (the dock reclaims it then), and is sent with
					    the check answer. */}
					{pending && teachingCheck && showReadingThinking && (
						<ReadingThinkingField
							key={pending.toolCallId}
							onUploadingChange={setReadingUploading}
							value={readingThinking}
							revision={readingThinkingRevision}
							onChange={onReadingThinking}
							onEscape={dictationCancel}
							onOpen={
								!expanded
									? () => {
											void finishDictation().then(() => {
												expandAndRevealRef.current();
											});
										}
									: undefined
							}
							claim={revealPending}
						/>
					)}
					<div ref={shellRef} data-attachment-composer="" className="pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg">
						{/* Include descendant margins (notably practice thinking's
						    bottom margin) in the natural content measurement. */}
						<div
							ref={contentRef}
							key={mode}
							className={mode === initialModeRef.current ? "flow-root" : "flow-root dock-variant"}
						>
							{pending ? (
								<QuestionDock
									toolName={pending.tool as "quiz" | "probe" | "ask_user_question" | "explain" | "recall"}
									toolCallId={pending.toolCallId}
									input={pending.input as never}
									expanded={expanded}
									reveal={revealPending}
									phase={phase}
									onExpand={expandAndReveal}
									onSubmit={onSubmitAnswer}
									initialDraft={initialQuestionDraft}
									onSaveDraft={onSaveQuestionDraft}
									onEscape={dictationCancel}
									dictationClaim={!revealPending || !showReadingThinking}
									attachmentsUploading={readingUploading}
									compactionRunning={compactionRunning}
								/>
							) : practice ? (
								<PracticeDock
									key={hydrated ? practice.toolCallId : `${practice.toolCallId}:server`}
									problemCallId={practice.toolCallId}
									input={practice.input as { statement: string }}
									expanded={expanded}
									onExpand={() => {
										setExpanded(true);
										void suppressFoldDuringReveal();
									}}
									onSubmit={onSubmitThinking}
									onEscape={dictationCancel}
									compactionRunning={compactionRunning}
								/>
							) : (
								composer
							)}
						</div>
					</div>
					</div>
					</div>
					{/* The stats row: beneath the composer/question shell, not
					    flush to the screen bottom — static height, outside the
					    morphing shell so it never joins a height animation. */}
					{footer}
					{/* The scroll-down disc: anchored to the block's top edge, in the
					    gradient's transparent band, so it never overlaps any dock
					    element and rides every height change live (typing, a
					    question expanding the band, the fold morph).
					    pointer-events-auto: the overlay is none by default. The
					    stick-to-bottom context reaches it because DockOverlay is a
					    Conversation child. */}
					<ConversationScrollButton className="pointer-events-auto bottom-full mb-2" />
				</div>
				{/* The plan marginalia: the bare diagram in the band's right flank,
				    mounted only while a question owns the band (its reserved height
				    is the canvas). Folding the dock fades and blurs it out. The box
				    shrinks with the flank; below MARGIN_MIN_W it fades rather than
				    unmounting mid-question. Click opens the popup. */}
				{pending && plan && (
					<Hint label="Open the full plan" side="bottom">
<button
						type="button"
						data-testid="plan-marginalia"
						onClick={overlay?.openPlan}
						style={{ left: flank.left, right: flank.right }}
						className={`absolute bottom-5 top-0 cursor-pointer transition-[filter,opacity] duration-300 ease-out ${
							expanded && flankW >= MARGIN_MIN_W
								? "pointer-events-auto opacity-100 blur-0"
								: "pointer-events-none opacity-0 blur-md"
						}`}
					>
						{plan}
					</button>
</Hint>
				)}
			</div>
		</div>
	);
}
