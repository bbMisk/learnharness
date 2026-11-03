/**
 * The per-lesson question type (owner, 2026-11-03): which quizzing tools the
 * TEACHER holds — MCQ = multiple choice (quiz) only, SAQ = short answer
 * (explain) only, Mixed = both. Stored per chat (ChatSettings.questionType);
 * unset resolves to Mixed for a cram lesson and to the app-wide Settings →
 * Agent mechanic otherwise (choice → MCQ, free → SAQ). The prober and
 * practice sessions never read it. Pure, browser-safe: the chat handler and
 * the header's Qs chip resolve the same way.
 */
import type { QuestionType } from "./contracts/chat.ts";
import type { EnabledTools } from "./pending.ts";

export const QUESTION_TYPES = ["mcq", "saq", "mixed"] as const satisfies readonly QuestionType[];

/** The chip's labels ("Qs: MCQ"). */
export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
	mcq: "MCQ",
	saq: "SAQ",
	mixed: "Mixed",
};

/** The teacher's prompt rule for a Mixed lesson (owner-approved wording,
 *  2026-11-03). Teach lessons get it as is; cram lessons get it in place of
 *  the question sentence of the loop's step 3 (core/cram.ts). */
export const MIXED_QUESTION_RULE =
	"Use multiple choice (quiz) by default; use short answer (explain) when he should produce the answer himself rather than recognize it among options — code, vocabulary, a brief proof or derivation, a computed value with its working, or anything the options would give away — and whenever your judgement says writing it out will show or build his understanding better.";

/** A stored value, or undefined when it is absent or not a known type (a
 *  record from a newer build, a hand edit): the read side never trusts it raw. */
export function sanitizeQuestionType(raw: unknown): QuestionType | undefined {
	return (QUESTION_TYPES as readonly unknown[]).includes(raw) ? (raw as QuestionType) : undefined;
}

/** The app-wide default: Settings → Agent's mechanic (`tools.explain === true`
 *  is free recall — agent/tools.ts quizMechanics reads the same key). */
export function appQuestionType(tools?: EnabledTools): QuestionType {
	return tools?.explain === true ? "saq" : "mcq";
}

/** The lesson's effective question type: an explicit stored value wins;
 *  unset is Mixed for a cram lesson, else the app-wide mechanic. */
export function effectiveQuestionType(stored: unknown, cram: boolean, tools?: EnabledTools): QuestionType {
	return sanitizeQuestionType(stored) ?? (cram ? "mixed" : appQuestionType(tools));
}
