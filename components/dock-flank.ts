/**
 * The plan marginalia's flank (owner, plan-placement round; moved out of
 * components/chat.tsx 2026-11-05 so it can be tested): the bare plan
 * diagram sits in the dock band's RIGHT flank — MARGIN_GAP from the DOCK
 * container's right edge and MARGIN_GAP from the band's right boundary.
 * The box width is pure CSS, so the diagram shrinks CONTINUOUSLY with the
 * flank; MARGIN_MIN_W is only the fade floor (owner, resize round) — below
 * it the marginalia fades out instead of popping away.
 *
 * The Progress card's make-room padding (Codex round 1, 2026-11-05): while
 * the card shows on a wide session area the dock block carries the
 * column's padding box (lessonTrackerRoom's `dock`), which moves the dock
 * left by half the card's lane. The flank follows: it starts MARGIN_GAP
 * right of the SHIFTED dock and ends MARGIN_GAP left of the card's lane.
 * `lane` is the block's right padding minus its left (the column gutter
 * the dock mirrors) — the card plus its edge gap; 0 with no room, which
 * gives exactly the pre-card geometry.
 */

/** The DOCK container's fixed width (46rem). */
export const DOCK_W = 46 * 16;
export const MARGIN_GAP = 16;
export const MARGIN_MIN_W = 220;

export interface DockFlank {
	/** The card's lane the block's padding reserves; 0 with no room. */
	lane: number;
	/** The flank's width in px (may be negative: no flank at all). */
	width: number;
	/** The marginalia's CSS `left` within the block's padding box. */
	left: string;
	/** The marginalia's CSS `right` in px. */
	right: number;
}

/** The flank for a block `blockWidth` px wide (border box) with the given
 *  computed left/right padding. Assumes the dock fits its 46rem (when it
 *  doesn't, the width is negative and the marginalia stays faded out). */
export function dockFlank(blockWidth: number, paddingLeft: number, paddingRight: number): DockFlank {
	const lane = Math.max(0, paddingRight - paddingLeft);
	return {
		lane,
		width: Math.round(blockWidth / 2 - DOCK_W / 2 - 2 * MARGIN_GAP - lane / 2),
		left: `calc(50% + ${DOCK_W / 2 + MARGIN_GAP - lane / 2}px)`,
		right: MARGIN_GAP + lane,
	};
}

/** The block's flank, measured live (its computed padding follows the
 *  make-room container query). */
export function measureDockFlank(block: HTMLElement): DockFlank {
	const style = getComputedStyle(block);
	return dockFlank(block.offsetWidth, parseFloat(style.paddingLeft) || 0, parseFloat(style.paddingRight) || 0);
}
