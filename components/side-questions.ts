/**
 * FORK: the app's one entry seam to upstream's side questions. chat.tsx
 * imports the side-thread hook, the selection action and the transcript entry
 * points from here instead of from their upstream modules, so the switch
 * (src/core/fork-config.ts) decides in one place whether they exist:
 *
 *   "questions": upstream's own exports, unchanged.
 *   "tutor" (default): an inert hook (no /side-chats fetch, no event
 *   subscription, never a thread), no selection action, no transcript entry.
 *
 * The switch is fixed at module load, so the hook choice never changes
 * between renders.
 */
import { sideEntryPoints as upstreamSideEntryPoints, sideQuestionsEnabled, type LhMessage, type LhViewMessage } from "@/src/core";
import { createSideQuestionActions as upstreamSideQuestionActions } from "./side-thread";
import { useSideThread as upstreamUseSideThread, type SideThreadOpenArgs } from "./use-side-thread";
import type { SelectionAction } from "./selection-toolbar";

export { SideThreadBody, SideThreadPanel, SideThreadPopover } from "./side-thread";
export type { SideThreadOpenArgs } from "./use-side-thread";

type SideThread = ReturnType<typeof upstreamUseSideThread>;

const NO_ENTRIES: ReadonlyMap<string, ReadonlyMap<number, string>> = new Map();
const NO_ACTIONS: SelectionAction[] = [];
const noop = () => {};
const INERT_THREAD: SideThread = {
	state: null,
	threads: [],
	open: noop,
	close: noop,
	ask: async () => false,
	stop: noop,
	draftFor: () => "",
	saveDraft: noop,
	currentSegmentId: null,
	expand: noop,
	float: noop,
	hasHistory: () => false,
};

function useInertSideThread(_chatId: string, _messages: readonly LhMessage[], _getWorking?: () => string): SideThread {
	return INERT_THREAD;
}

export const useSideThread: typeof upstreamUseSideThread = sideQuestionsEnabled ? upstreamUseSideThread : useInertSideThread;

export const createSideQuestionActions: (args: { open: (args: SideThreadOpenArgs) => void }) => SelectionAction[] =
	sideQuestionsEnabled ? upstreamSideQuestionActions : () => NO_ACTIONS;

export const sideEntryPoints: (messages: readonly LhMessage[], view: readonly LhViewMessage[]) => ReadonlyMap<string, ReadonlyMap<number, string>> =
	sideQuestionsEnabled ? upstreamSideEntryPoints : () => NO_ENTRIES;
