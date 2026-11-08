"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import { ArrowDownIcon, ChevronRightIcon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { finishDictation, isDictationActive, joinDictation, useDictationTarget } from "@/components/dictation";
import { useEnterSubmits } from "@/components/enter-submits";
import { PathInput } from "@/components/path-input";
import { useThinkingFocus } from "@/components/thinking-focus";
import { MalformedQuestion } from "@/components/malformed-question";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import {
	buildAnswer,
	repairMathForDisplay,
	normalizeQuizType,
	CONFIDENCE_STOPS,
	DEFAULT_CONFIDENCE_INDEX,
	emptyDockSelection,
	normalizeOptions,
	resolveCorrect,
	seededRandom,
	shuffleOptions,
	toolQuestionKind,
	parseAskInput,
	parseQuizInput,
	parseExplainInput,
	toggleOption,
	toggleOther,
	type AnswerRequest,
	type AskToolInput,
	type DockSelection,
	type ExplainToolInput,
	type QuestionAnswerData,
	type QuestionFormDraft,
	type QuestionData,
	type QuestionMode,
	type QuizToolInput,
	type SelectMode,
	type Phase3,
} from "@/src/core";
import { CONFIDENCE_COLORS, confidenceRailStyle } from "@/components/confidence-rail";
import { useFileDrop } from "@/components/file-drop";
import { FileDropFeedback } from "@/components/file-drop-feedback";
import { verbatimInputProps } from "@/components/verbatim-input";

/**
 * The question dock: a pending quiz/ask replaces the chat composer in the
 * persistent bottom dock. The teacher's side (question, options) meets the
 * learner's "Your thinking", a labeled composer-twin field with Submit docked
 * inside it like the composer's send.
 *
 * The thinking field is the product's transfer channel: never called
 * "optional", sized by phase (probing stays quick; teaching invites depth).
 * The "Other…" option is an editable option row (circle + inline input), so
 * picking Other never displaces thinking.
 *
 * Collapse (scroll-up → slim bar), the shell and its height morph are owned
 * by DockOverlay; this component is content only. The expanded form stays
 * mounted while collapsed (hidden) so a half-made selection survives.
 */

export interface QuestionDockProps {
	toolName: "quiz" | "probe" | "ask_user_question" | "explain" | "recall";
	toolCallId: string;
	input: QuizToolInput | AskToolInput | ExplainToolInput;
	/** Collapse state, owned by the DockOverlay (it drives the shell's height morph). */
	expanded: boolean;
	/**
	 * Teach-phase check awaiting its reveal: while collapsed, the bar is the
	 * "Check your understanding" invitation instead of the scroll-collapse
	 * strip. Owned by DockOverlay; false once the learner has revealed.
	 */
	reveal?: boolean;
	onExpand: () => void;
	onSubmit: (output: QuestionAnswerData) => void;
	/** Restore only this call's unconfirmed submission after recovery. */
	initialDraft?: QuestionFormDraft;
	onSaveDraft?: (draft: QuestionFormDraft) => void;
	/** Escape in a question field stops dictation (threaded from the page
	 *  that owns the dictation hook). */
	onEscape?: () => void;
	/** The keyboard machine is armed only while the dock is expanded; the
	 *  collapsed bar keeps its native Enter-to-expand. */
	active?: boolean;
	/** Session phase at the question — scales the thinking field: probing
	 *  stays quick (one row), teaching invites dumping (three rows). */
	phase?: Phase3;
	/** Dictation claim: false while a teach-phase check sits unrevealed (the
	 *  reading-thinking field owns dictated speech during the reading); the
	 *  dock reclaims on reveal. Default true. */
	dictationClaim?: boolean;
	/** Compaction is running for this chat: the answer POST would block on
	 *  the server's compaction gate, so submit disables and the hint row says
	 *  so. The server registry is the real gate; this is the affordance. */
	compactionRunning?: boolean;
	attachmentsUploading?: boolean;
}

export function QuestionDock({
	toolName,
	toolCallId,
	input,
	expanded,
	reveal = false,
	onExpand,
	onSubmit,
	initialDraft,
	onSaveDraft,
	onEscape,
	phase = "probe",
	dictationClaim = true,
	compactionRunning = false,
	attachmentsUploading = false,
}: QuestionDockProps) {
	// The probe-phase names map onto their teach twins for every dock concern
	// (parse dispatch, labels, kinds): "probe" is quiz-shaped, "recall" is
	// explain-shaped. Old records keep the teach names.
	const canonical =
		toolName === "probe" ? "quiz" : toolName === "recall" ? "explain" : toolName;
	// The chip's display name: probe-phase questions label Probe/Recall; teach
	// tools keep the standing labels.
	const toolLabel = toolName === "probe" ? "Probe" : toolName === "recall" ? "Recall" : undefined;
	// Parse, don't cast (src/core/tool-parts.ts): the model authored this
	// input. It was validated upstream, so this is defense in depth: anything
	// that slips through renders the quiet fallback, never a crash on `.map`
	// over model-authored bytes.
	const parsed =
		canonical === "quiz" ? parseQuizInput(input) : canonical === "explain" ? parseExplainInput(input) : parseAskInput(input);
	if (!parsed) {
		return <MalformedQuestion />;
	}
	return (
		<>
			{!expanded && (
				<QuestionDockBar
					toolName={canonical}
					question={parsed.question}
					onExpand={onExpand}
					variant={reveal ? "reveal" : "collapsed"}
					toolLabel={toolLabel}
					label={
						(canonical === "quiz" || canonical === "explain") &&
						normalizeQuizType((parsed as { type?: unknown }).type) === "predict"
							? "Prediction"
							: undefined
					}
				/>
			)}
			<div className={expanded ? "dock-variant" : "invisible h-0 overflow-hidden"}>
				<QuestionDockForm
					onReveal={onExpand}
					key={toolCallId}
					toolName={toolName}
					toolCallId={toolCallId}
					input={parsed}
					phase={phase}
					active={expanded}
					onSubmit={onSubmit}
					initialDraft={initialDraft}
					onSaveDraft={onSaveDraft}
					onEscape={onEscape}
					dictationClaim={dictationClaim}
					compactionRunning={compactionRunning}
					attachmentsUploading={attachmentsUploading}
				/>
			</div>
		</>
	);
}

/** The collapsed bar's one-line teaser: prose as text, math rendered inline
 *  by KaTeX (display math too — the bar is one truncated line). */
export function QuestionTeaser({ question }: { question: string }) {
	const text = repairMathForDisplay(question).replace(/\s+/g, " ").trim();
	const math = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|(?<!\\)\$((?:\\.|[^$\\])+)\$/g;
	const out: React.ReactNode[] = [];
	let at = 0;
	for (const m of text.matchAll(math)) {
		if (m.index > at) out.push(text.slice(at, m.index));
		const html = katex.renderToString((m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim(), { throwOnError: false });
		// katex.renderToString is the library's own trusted output (latex-glyph.tsx).
		out.push(<span key={m.index} dangerouslySetInnerHTML={{ __html: html }} />);
		at = m.index + m[0].length;
	}
	if (at < text.length) out.push(text.slice(at));
	return <>{out}</>;
}

/** The collapsed strip. "collapsed" is the scroll minimization (kind chip +
 *  one-liner + Answer ↓); "reveal" is the teach-check invitation, a more
 *  inviting affordance because it asks the learner to start something. */
export function QuestionDockBar({
	toolName,
	question,
	onExpand,
	variant = "collapsed",
	label,
	toolLabel,
}: {
	toolName: "quiz" | "ask_user_question" | "explain";
	question: string;
	onExpand: () => void;
	variant?: "collapsed" | "reveal";
	/** The kind chip's text: "Prediction" when a predict-type quiz is folded
	 *  by scroll (predictions never use the reveal variant). */
	label?: string;
	/** The chip's tool display name: probe-phase calls label Probe/Recall. */
	toolLabel?: string;
}) {
	if (variant === "reveal") {
		return (
			<button
				type="button"
				data-testid="teach-check-reveal"
				onClick={onExpand}
				className="dock-variant flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
			>
				<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
					<PlayIcon className="size-3.5" />
				</span>
				<span className="min-w-0 flex-1">
					<span className="block text-sm font-medium">Check your understanding</span>
					<span className="block truncate text-xs text-muted-foreground"><QuestionTeaser question={question} /></span>
				</span>
				<span className="flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
					Open <ChevronRightIcon className="size-3.5" />
				</span>
			</button>
		);
	}
	return (
		<button
			type="button"
			data-testid="question-dock-bar"
			onClick={onExpand}
			className="dock-variant flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-accent/40"
		>
			<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{label ??
							toolLabel ??
							(toolName === "quiz" ? "Check" : toolName === "explain" ? "Explain" : "Question")}
			</span>
			<span className="min-w-0 flex-1 truncate text-muted-foreground"><QuestionTeaser question={question} /></span>
			<span className="flex shrink-0 items-center gap-1 text-xs font-medium">
				Answer <ArrowDownIcon className="size-3.5" />
			</span>
		</button>
	);
}

/** The expanded question: label, question, options, and the unified bottom row. */
function QuestionDockForm({
	toolName,
	toolCallId,
	input,
	phase = "probe",
	active,
	onSubmit,
	onReveal,
	initialDraft,
	onSaveDraft,
	onEscape,
	dictationClaim = true,
	compactionRunning = false,
	attachmentsUploading = false,
}: Omit<QuestionDockProps, "expanded" | "onExpand" | "reveal"> & {onReveal?: () => void}) {
	const kind = toolQuestionKind(toolName);

	// Canonical QuestionData, built once per question. Quiz options are
	// deterministically shuffled (seeded by toolCallId) so position never leaks
	// correctness AND server/client render the same order (hydration-safe);
	// the display order is snapshotted into the answer record at submit time.
	const qd = useMemo<QuestionData>(() => {
		const quizInput = kind === "quiz" ? (input as QuizToolInput) : null;
		const askInput = kind === "ask" ? (input as AskToolInput) : null;
		const explainInput = kind === "explain" ? (input as ExplainToolInput) : null;
		const multi = input instanceof Object && "multiSelect" in input ? input.multiSelect === true : false;
		const mode: QuestionMode =
			kind === "quiz"
				? multi
					? "multi-select"
					: "single-select"
				: askInput?.options?.length
					? multi
						? "multi-select"
						: "single-select"
						: "text";
		const options = normalizeOptions(
			(quizInput?.options ?? askInput?.options ?? []) as { label: string; value?: string }[],
		);
		const ordered = kind === "quiz" && options.length > 0 ? shuffleOptions(options, seededRandom(toolCallId)) : options;
		const q: QuestionData = {
			id: toolCallId,
			kind,
			// Predict questions gate by it in the view and the answered card
			// tucks the explanation.
			questionType: kind === "quiz" ? normalizeQuizType((input as { type?: unknown }).type) : undefined,
			question: input.question,
			context: input.details,
			mode,
			options: ordered,
			createdAt: new Date().toISOString(),
		};
		if (quizInput) {
			const resolved = resolveCorrect(quizInput.correctAnswer, ordered);
			if (resolved.error) console.error("[quiz] correctAnswer did not resolve:", resolved.error);
			q.correctIndices = resolved.indices;
			q.explanation = quizInput.explanation;
		}
		if (explainInput) {
			// The commitment rides the question data (never shown before
			// answering) and snapshots into the answer at submit. One field,
			// reasoning included.
			q.committedAnswer = explainInput.correctAnswer;
		}
		return q;
	}, [toolCallId, kind, input]);

	// The selection state machine lives in question-core (pure, tested):
	// single-select displaces, multi-select coexists — picking the ask
	// "Other…" row in a multi-select must never clear already-picked
	// options, and picking an option must never clear a typed custom answer.
	const [sel, setSel] = useState<DockSelection>(() => initialDraft?.selection ?? emptyDockSelection());
	// The learner's transfer channel: thinking, never "a note".
	const [thinking, setThinking] = useState(initialDraft?.thinking ?? "");
	const [other, setOther] = useState(initialDraft?.other ?? "");
	const [text, setText] = useState(initialDraft?.text ?? "");
	/* Refs mirror the two dictation-target fields: the run's flush lands via
	 * setState, which a closure waiting through `await finishDictation()`
	 * cannot observe in time. Submit reads these, kept current at every write
	 * site. */
	const thinkingTextRef = useRef(initialDraft?.thinking ?? "");
	const answerTextRef = useRef(initialDraft?.text ?? "");
	const files = useFileDrop(qd.mode === "text" ? text : thinking, (value) => {
		if (qd.mode === "text") { answerTextRef.current = value; setText(value); }
		else { thinkingTextRef.current = value; setThinking(value); }
	}, {hideImagePaths:true,priority:20,label:"your answer",activate:onReveal});
	// Confidence: an index into CONFIDENCE_STOPS, resting at 50 (a coin flip,
	// whether untouched or deliberate). The dock unmounts between questions,
	// so each question starts fresh at 50.
	const [confIdx, setConfIdx] = useState<number>(initialDraft?.confidenceIndex ?? DEFAULT_CONFIDENCE_INDEX);
	const selectMode: SelectMode = qd.mode === "multi-select" ? "multi-select" : "single-select";
	// Autosave: the open answer survives reloads and chat switches.
	const saveDraftRef = useRef(onSaveDraft);
	saveDraftRef.current = onSaveDraft;
	useEffect(() => {
		saveDraftRef.current?.({ selection: sel, thinking, other, text, confidenceIndex: confIdx });
	}, [sel, thinking, other, text, confIdx]);
	const otherFiles = useFileDrop(other, (value) => {
		setOther(value);
		if (value.trim()) setSel((prev) => prev.otherSelected ? prev : toggleOther(selectMode, prev));
	}, {hideImagePaths:true,priority:15,label:"your custom answer",activate:onReveal});

	// The primary dictation input: while a question waits, dictated finals
	// land here, never in the hidden composer (text mode → "Your answer",
	// select modes → "Your thinking"). The claim is effect-scoped, so the
	// question unmounting releases it back to the composer.
	useDictationTarget(
		useCallback(
			(t: string) => {
				// Ref-first (see the refs block above): the join is computed from
				// the mirror, then both mirrors agree with state — a submit
				// resuming post-finish reads the tail, never a stale closure.
				files.changeText(joinDictation(files.currentText(), t));
			},
			[files],
		),
		// Released while a teach check sits unrevealed: the reading-thinking
		// field owns dictated speech during the reading.
		dictationClaim,
	);

	const toggle = (idx: number) => setSel(toggleOption(selectMode, sel, idx));

	const canSubmit =
		qd.mode === "text"
			? text.trim().length > 0
			: sel.dontKnow || (sel.otherSelected && other.trim().length > 0) || sel.selected.size > 0;

	const submit = () => {
		if (!canSubmit || compactionRunning || attachmentsUploading || files.isUploading() || otherFiles.isUploading()) return;
		/* Finish dictation first: Enter may arrive while a run is live with
		 * reasoning still in the transcriber's hands. Stop the run, let the
		 * last finals land, and only then build the answer. The field values
		 * come from the ref mirrors because the flush lands via setState after
		 * an await. */
		if (!isDictationActive()) {
			doSubmit();
			return;
		}
		void finishDictation().then(doSubmit);
	};
	const doSubmit = () => {
		if (!canSubmit || attachmentsUploading || files.isUploading() || otherFiles.isUploading()) return;
		const req: AnswerRequest = {
			dontKnow: sel.dontKnow,
			values: [...sel.selected].map((i) => qd.options[i]!.value),
			other: sel.otherSelected ? other : undefined,
			text: qd.mode === "text" ? answerTextRef.current : undefined,
			thinking: qd.mode !== "text" ? thinkingTextRef.current.trim() || undefined : undefined,
			// Always sent on quiz answers (50 means 50, never "untouched");
			// buildAnswer drops it on "I don't know".
			confidence: kind === "quiz" ? CONFIDENCE_STOPS[confIdx] : undefined,
		};
		// Snapshot before optimistic submission unmounts the form. Ref values
		// include the dictation finals that just landed, unlike stale closures.
		onSaveDraft?.({
			selection: { ...sel, selected: new Set(sel.selected) },
			thinking: thinkingTextRef.current,
			other,
			text: answerTextRef.current,
			confidenceIndex: confIdx,
		});
		onSubmit(buildAnswer(qd, req, toolName));
	};

	/* Enter submits from anywhere, like the practice dock (dictated answers
	 * rarely focus the field). It goes through submit(), so the dictation
	 * flush is shared. */
	useEnterSubmits(submit);

	// Selecting Other never clears the thinking field: the answer and the
	// reasoning behind it are separate channels.
	const selectOther = () => setSel(toggleOther(selectMode, sel));

	/* ── The keyboard machine ──
	   ↑/↓ walk every answerable row in order (options, then the quiz's
	   "I don't know" or the ask's "Other…"), clamped at the ends, no wrap.
	   Space acts on the walked row like a click (multi toggles, single
	   displaces; Other also focuses its input), Enter submits once an answer
	   exists. Tab toggles focus between the thinking field and the answer
	   rows, nothing else; Shift+Tab is not ours (the global thinking-level
	   cycle owns it). Two guards keep native behavior
	   intact: keys from a TYPING SURFACE keep their meaning (arrows move
	   the caret, space types), and modifier combos are never ours
	   (Alt+arrows cycle sessions — they must not ALSO walk the rows).
	   The listener is document-level and lives only while the dock is
	   expanded — collapsed, the bar's native Enter expands it. */
	const [kbdIdx, setKbdIdx] = useState<number | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const otherInputRef = useRef<HTMLDivElement>(null);
	const thinkingRef = useRef<HTMLDivElement>(null);
	useThinkingFocus(rootRef, thinkingRef, !!active && qd.mode !== "text");
	// One row past the options is the trailing row: quiz → don't-know,
	// ask → Other (a question never has both). Text mode (ask/explain)
	// has no rows — the composer IS the answer surface.
	const optionCount = qd.mode === "text" ? 0 : qd.options.length;
	const rowCount = qd.mode === "text" ? 0 : optionCount + 1;

	const kbdAct = (idx: number) => {
		if (idx < optionCount) toggle(idx);
		else if (kind === "quiz")
			setSel((prev) => ({ ...prev, selected: new Set(), otherSelected: false, dontKnow: !prev.dontKnow }));
		else {
			// Space on the ask's Other row: selecting it focuses the input, but
			// the Space that deselects an already-selected Other must not drop
			// the user back into the field. The core's toggleOther has no
			// single-select off-path (it displaces), so it lives here: clear
			// the pick, keep the typed text, leave focus where it is.
			if (sel.otherSelected) setSel((prev) => ({ ...prev, otherSelected: false, dontKnow: false }));
			else {
				otherInputRef.current?.focus();
				selectOther();
			}
		}
	};

	// Focus the walked row's focusable element — the Other row is a div,
	// so its inline input is the focus target there.
	const focusRow = (idx: number) => {
		const row = rootRef.current?.querySelector(`[data-kbdrow="${idx}"]`) as HTMLElement | null;
		if (!row) return;
		const el = (row.querySelector("input, [data-file-path-input]") as HTMLElement | null) ?? row;
		el.focus();
	};

	useEffect(() => {
		if (!active || rowCount === 0) return;
		const onKeyDown = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement | null;
			// A typing field is where keys mean text (the thinking/answer
			// fields, search boxes, renames), never a range input, whose focus
			// after a click or drag must not kill the arrow cycling.
			const typing =
				!!t &&
				((t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range") ||
					t.tagName === "TEXTAREA" ||
					t.isContentEditable);
			// Alt/Cmd/Ctrl combos are never ours (Alt+arrows cycle sessions
			// globally — they must not ALSO walk the question rows).
			const modded = e.altKey || e.metaKey || e.ctrlKey;
			// Plain Tab toggles focus: rows → thinking. The confidence slider
			// never joins the chain (global ←/→ own its keyboard).
			// Shift+Tab falls through (the global thinking-level cycle owns
			// it), so the shift check matters.
			if (e.key === "Tab" && !e.shiftKey && !modded) {
				e.preventDefault();
				e.stopPropagation();
				if (t?.closest?.("[data-kbdrow]")) thinkingRef.current?.focus();
				else {
					const idx = kbdIdx ?? 0;
					setKbdIdx(idx);
					focusRow(idx);
				}
				return;
			}
			// Keys from a typing surface keep their meaning (arrows move
			// the caret, space types).
			if (typing || modded) return;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				const next = Math.min((kbdIdx ?? -1) + 1, rowCount - 1);
				setKbdIdx(next);
				// Focus follows the walk while the user is IN the rows (Tab
				// put them there) so focused and walked never diverge.
				if (t?.closest?.("[data-kbdrow]")) focusRow(next);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				const next = Math.max((kbdIdx ?? rowCount) - 1, 0);
				setKbdIdx(next);
				if (t?.closest?.("[data-kbdrow]")) focusRow(next);
			} else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
				// Global confidence cycling, like ↑/↓ over the rows: works
				// wherever focus sits. Dead on "I don't know" (the slider grays
				// out and nothing is sent).
				if (kind !== "quiz" || sel.dontKnow) return;
				e.preventDefault();
				setConfIdx((i) =>
					Math.min(
						CONFIDENCE_STOPS.length - 1,
						Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)),
					),
				);
			} else if (e.key === " ") {
				if (kbdIdx === null) return; // plain Space keeps scrolling the page
				e.preventDefault();
				kbdAct(kbdIdx);
			} else if (e.key === "Enter") {
				if (kbdIdx === null || !canSubmit) return;
				e.preventDefault();
				submit();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	});

	// Keep the walked row visible (the question area scrolls internally).
	useEffect(() => {
		if (kbdIdx === null) return;
		rootRef.current
			?.querySelector(`[data-kbdrow="${kbdIdx}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [kbdIdx]);

	return (
		<div ref={rootRef} data-testid="question-dock">
			{/* Question area: scrolls internally if very tall; the bottom row stays
			    put. Capped by the measured column (--dock-max-h). */}
			<div data-dock-scroll-area="" data-session-find-root="" className="max-h-[var(--dock-max-h,55dvh)] overflow-y-auto px-4 pt-3">
				<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{toolName === "probe"
						? "Probe"
						: toolName === "recall"
							? "Recall"
							: kind === "quiz"
								? qd.questionType === "predict"
									? "Prediction"
									: "Check"
									: kind === "explain"
										? "Explain"
											: "Question"}
					{qd.mode === "multi-select" && " · select all that apply"}
				</div>
				<div className="mb-3 font-medium">
					<ToolContentResponse>{qd.question}</ToolContentResponse>
				</div>
				{qd.context && (
					<div className="mb-3 text-sm text-muted-foreground">
						<ToolContentResponse>{qd.context}</ToolContentResponse>
					</div>
				)}

				{qd.mode !== "text" && (
					<div className="flex flex-col gap-2 pb-2" role={qd.mode === "multi-select" ? "group" : "radiogroup"}>
						{qd.options.map((opt, i) => {
							const isSel = sel.selected.has(i);
							return (
								<button
									key={opt.value}
									type="button"
									role={qd.mode === "multi-select" ? "checkbox" : "radio"}
									aria-checked={isSel}
									data-kbdrow={i}
									onClick={() => toggle(i)}
									className={cn(
										"flex items-start gap-3 rounded-lg border px-3 py-2 text-left text-sm outline-none transition-colors",
										isSel ? "border-primary bg-accent" : "hover:bg-accent/50",
										i === kbdIdx && !isSel && "ring-1 ring-border bg-accent/40",
									)}
								>
									<span
										className={cn(
											"mt-0.5 flex size-4 shrink-0 items-center justify-center border",
											qd.mode === "multi-select" ? "rounded-sm" : "rounded-full",
											isSel ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
										)}
									>
										{isSel && (
											<span className={cn(qd.mode === "multi-select" ? "text-base leading-none" : "size-1.5 rounded-full bg-current")}>
												{qd.mode === "multi-select" ? "✓" : ""}
											</span>
										)}
									</span>
									<span>
										<ToolContentResponse>{opt.label}</ToolContentResponse>
										{kind !== "quiz" && opt.description && (
											// Option subtext renders as full markdown (LaTeX included)
											// through the label's path. Quiz options render no description:
											// it could telegraph correctness, and old records must not leak.
											<ToolContentResponse className="lh-prose block text-xs text-muted-foreground">
												{opt.description}
											</ToolContentResponse>
										)}
									</span>
								</button>
							);
						})}

						{kind === "quiz" && (
							<button
								type="button"
								onClick={() =>
									setSel((prev) => ({ ...prev, selected: new Set(), otherSelected: false, dontKnow: !prev.dontKnow }))
								}
								data-kbdrow={optionCount}
								aria-pressed={sel.dontKnow}
								className={cn(
									// Option-row layout + radio circle; the dashed outline marks
									// the deliberate non-answer.
									"flex items-start gap-3 rounded-lg border border-dashed px-3 py-2 text-left text-sm outline-none transition-colors",
									sel.dontKnow ? "border-primary text-foreground" : "text-muted-foreground",
									kbdIdx === optionCount && !sel.dontKnow && "ring-1 ring-border bg-accent/40",
								)}
							>
								<span
									className={cn(
										"mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
										sel.dontKnow
											? "border-primary bg-primary text-primary-foreground"
											: "border-muted-foreground/40",
									)}
								>
									{sel.dontKnow && <span className="size-1.5 rounded-full bg-current" />}
								</span>
								<span>I don't know</span>
							</button>
						)}

						{kind === "ask" && (
							<div
								role={qd.mode === "multi-select" ? "checkbox" : "radio"}
								aria-checked={sel.otherSelected}
								data-testid="other-option"
								data-kbdrow={optionCount}
								onClick={selectOther}
								className={cn(
									"flex items-start gap-3 rounded-lg border px-3 py-2 text-left text-sm outline-none transition-colors",
									sel.otherSelected ? "border-primary bg-accent" : "border-dashed hover:bg-accent/50",
									kbdIdx === optionCount && !sel.otherSelected && "ring-1 ring-border bg-accent/40",
								)}
							>
								<span
									className={cn(
										"mt-0.5 flex size-4 shrink-0 items-center justify-center border",
										qd.mode === "multi-select" ? "rounded-sm" : "rounded-full",
										sel.otherSelected
											? "border-primary bg-primary text-primary-foreground"
											: "border-muted-foreground/40",
									)}
								>
									{sel.otherSelected && (
										<span className={cn(qd.mode === "multi-select" ? "text-base leading-none" : "size-1.5 rounded-full bg-current")}>
											{qd.mode === "multi-select" ? "✓" : ""}
										</span>
									)}
								</span>
								<PathInput
									ref={otherInputRef}
									singleLine
									value={otherFiles.text}
									{...otherFiles.handlers}
									onValueChange={(value) => {
										otherFiles.changeText(value);
										// Typing selects the row — displacing in
										// single-select, alongside the siblings in multi.
										setSel((prev) => (prev.otherSelected ? prev : toggleOther(selectMode, prev)));
									}}
									onKeyDown={(e) => {
										// Esc leaves the input; the row stays selected (the next
										// Space deselects) and the arrow walk resumes from this row
										// (kbdIdx pins it). stopPropagation keeps the window chain
										// from reading this Esc as abort-turn.
										if (e.key === "Escape") {
											e.preventDefault();
											e.stopPropagation();
											e.currentTarget.blur();
											setKbdIdx(optionCount);
										}
											// Enter submits directly: the custom answer is a one-line
											// input and typing already selected the row. Every Enter
											// (shift or not) goes through the button's submit, dictation
											// finish-first included.
											if (e.key === "Enter") {
												e.preventDefault();
												submit();
											}
									}}
									placeholder="Type your own answer…"
									className="lh-input w-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
									onClick={(e) => e.stopPropagation()}
								/>
							</div>
						)}
					</div>
				)}
			</div>

			{/* Confidence: a snapped slider between the options and "Your
				thinking", the learner's stated probability that the selected
				answer is correct. The thumb's position is the raw fraction; the
				painted rail spans exactly the thumb-center range, so 0 and 100
				sit flush at its ends. Fill and handle wear the stop's ramp color;
				stop ticks sit behind the fill (empty side only). Keyboard: global
				←/→. "I don't know" grays it out and no value is sent. */}
			{kind === "quiz" && (
				<div className="border-t border-border/60 px-4 py-2.5">
					<div className="flex items-center gap-3">
						<span
							className={cn(
								"shrink-0 text-xs font-medium uppercase tracking-wide",
								sel.dontKnow ? "text-muted-foreground/50" : "text-muted-foreground",
							)}
						>
							Confidence
						</span>
						<div
							className={cn("relative h-4 min-w-0 flex-1", sel.dontKnow && "opacity-40")}
							data-testid="confidence-track"
						>
							{/* The rail is painted here, not on the input: this overlay spans
								exactly the thumb-center range (inset 8px = half the 16px disc),
								so at 0 and 100 the disc sits flush at the rail's ends.
								Stacking: the input is absolute too, because a positioned
								overlay paints above an in-flow input regardless of DOM order;
								both positioned, the later input's disc rides on top. The
								wrapper's height is pinned (h-4) so the rail's top-1/2 and the
								disc's track share one box. */}
							<div
								aria-hidden
								data-testid="confidence-rail"
								className="pointer-events-none absolute top-1/2 left-2 right-2 h-1.5 -translate-y-1/2 rounded-full border border-border"
								style={confidenceRailStyle(CONFIDENCE_STOPS[confIdx]!)}
							/>
							<input
								type="range"
								min={0}
								max={100}
								step={1}
								value={CONFIDENCE_STOPS[confIdx]}
								disabled={sel.dontKnow}
								aria-label="Confidence — the probability your selected answer is correct"
								aria-valuetext={`${CONFIDENCE_STOPS[confIdx]} percent`}
								title="The probability your selected answer is correct — 50% is a coin flip. Adjust with ←/→."
								data-testid="confidence-slider"
								onChange={(e) => {
									// Snap to the nearest stop; the rendered VALUE is the stop's own
									// percent, so the thumb always rests at its true fraction (50 =
									// halfway). Keyboard needs no handler here: the dock machine treats
									// a focused range as non-typing (see the guard above) and its ←/→
									// branch preventDefaults, which also cancels the native 1% step.
									const v = Number(e.target.value);
									let best = 0;
									for (let i = 1; i < CONFIDENCE_STOPS.length; i++) {
										if (Math.abs(CONFIDENCE_STOPS[i]! - v) < Math.abs(CONFIDENCE_STOPS[best]! - v)) best = i;
									}
									setConfIdx(best);
								}}
								style={{ color: CONFIDENCE_COLORS[confIdx] }}
								className={cn(
									"absolute inset-0 h-4 w-full cursor-pointer appearance-none bg-transparent outline-none",
									"[&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:bg-transparent",
									"[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-current",
									"[&::-moz-range-track]:h-4 [&::-moz-range-track]:bg-transparent",
									"[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-current",
								)}
							/>
						</div>
						<span
							data-testid="confidence-value"
							className={cn(
								"w-9 shrink-0 text-right font-mono text-sm tabular-nums",
								sel.dontKnow && "text-muted-foreground/50",
							)}
						>
							{sel.dontKnow ? "—" : `${CONFIDENCE_STOPS[confIdx]}%`}
						</span>
					</div>
				</div>
			)}

			{/* The learner's half of the dock, a composer twin: a labeled,
			    bordered field with Submit docked inside. Select modes get "Your
			    thinking", text mode "Your answer"; both submit on Enter
			    (Shift+Enter is a newline). */}
			<form
				className="border-t border-border/60 p-1.5"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<div
					data-testid={qd.mode === "text" ? "answer-field" : "thinking-field"}
					{...files.handlers}
					className="rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50"
				>
					<div className="px-2.5 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						{qd.mode === "text" ? "Your answer" : "YOUR THINKING"}
					</div>
					<FileDropFeedback files={otherFiles} />
					<FileDropFeedback files={files} />
					{qd.mode === "text" ? (
						<PathInput
							{...verbatimInputProps}
							value={files.text}
							onValueChange={(value) => {
								files.changeText(value);
							}}
							onKeyDown={(e) => {
								// Esc ends dictation; stopPropagation claims it so the
								// window chain doesn't also abort a turn.
								if (e.key === "Escape" && onEscape) {
									e.preventDefault();
									e.stopPropagation();
									onEscape();
									return;
								}
								// Chat convention: Enter submits, Shift+Enter is a newline;
								// ⌘/Ctrl+Enter also submits (universal across the app).
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
									e.preventDefault();
									submit();
								}
							}}
							placeholder="Type your answer…"
							className="field-sizing-content lh-input max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
						/>
					) : (
						<PathInput
							{...verbatimInputProps}
							ref={thinkingRef}
							value={files.text}
							onValueChange={(value) => {
								files.changeText(value);
							}}
							onKeyDown={(e) => {
								// Esc ends dictation; stopPropagation claims it so the
								// window chain doesn't also abort a turn.
								if (e.key === "Escape" && onEscape) {
									e.preventDefault();
									e.stopPropagation();
									onEscape();
									return;
								}
								// The standard chord: Enter submits, Shift+Enter is a
								// newline, ⌘/Ctrl+Enter works too (as in the composer).
								if (e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
									e.preventDefault();
									submit();
								}
							}}
							placeholder="Why this answer? Whatever comes to mind."
							className={cn(
								"field-sizing-content lh-input max-h-48 w-full resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground/70",
								// Phase-scaled prominence: teaching invites depth,
								// probing stays quick.
								phase === "teach" ? "min-h-[4.5rem]" : "min-h-10",
							)}
						/>
					)}
					<div className="flex items-center justify-between gap-2 p-1">
						<span aria-hidden className="pl-1.5 text-xs text-muted-foreground">
								{compactionRunning ? "compacting session…" : "↵ submits · ⇧↵ newline"}
						</span>
						<Button
							type="submit"
							disabled={!canSubmit || compactionRunning || attachmentsUploading || files.uploading || otherFiles.uploading}
							className="ml-auto h-9 rounded-[6px] px-3.5 text-sm font-medium"
						>
							Submit answer
						</Button>
					</div>
				</div>
			</form>
		</div>
	);
}
