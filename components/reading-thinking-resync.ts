"use client";

import { useLayoutEffect, type Dispatch, type RefObject, type SetStateAction } from "react";

export interface ReadingThinkingSeed {
	questionId: string | null;
	value: string;
	revision: number;
}

/** Typing lands in a ref (the transcript does not rerender per keystroke), so
 *  a field remounted by the visibility toggle must start from the ref, not
 *  from the seed it was first opened with. */
export function useReadingThinkingResync(
	visible: boolean,
	draft: RefObject<string>,
	setSeed: Dispatch<SetStateAction<ReadingThinkingSeed>>,
): void {
	useLayoutEffect(() => {
		if (!visible) return;
		setSeed((previous) =>
			previous.value === draft.current ? previous : { ...previous, value: draft.current, revision: previous.revision + 1 },
		);
	}, [visible, draft, setSeed]);
}
