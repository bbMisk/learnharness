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
 * The dock's shift is the block's right padding minus its left; `lane` is
 * the card plus its edge gap (--lh-room-lane, globals.css). With the
 * transcript at Full the two are equal. With a transcript width set the
 * column may clear the card, so the dock shifts less (or not at all) while
 * the card's lane stays; 0 for both with no room, which gives exactly the
 * pre-card geometry.
 */

/** The DOCK container's fixed width (46rem). */
export const DOCK_W = 46 * 16;
export const MARGIN_GAP = 16;
export const MARGIN_MIN_W = 220;

export interface DockFlank {
	/** The card's lane at the block's right edge; 0 with no room. */
	lane: number;
	/** The flank's width in px (may be negative: no flank at all). */
	width: number;
	/** The marginalia's CSS `left` within the block's padding box. */
	left: string;
	/** The marginalia's CSS `right` in px. */
	right: number;
}

/** The flank for a block `blockWidth` px wide (border box) with the given
 *  computed left/right padding, beside a dock `dockWidth` px wide (46rem, or
 *  wider while an adapted question card owns it), left of a card lane
 *  `cardLane` px wide at the block's right (at least the dock's shift).
 *  Assumes the dock fits (when it doesn't, the width is negative and the
 *  marginalia stays faded out). */
export function dockFlank(blockWidth: number, paddingLeft: number, paddingRight: number, dockWidth = DOCK_W, cardLane = 0): DockFlank {
	const shift = Math.max(0, paddingRight - paddingLeft);
	const lane = Math.max(shift, cardLane);
	return {
		lane,
		width: Math.round(blockWidth / 2 - dockWidth / 2 - 2 * MARGIN_GAP - lane + shift / 2),
		left: `calc(50% + ${dockWidth / 2 + MARGIN_GAP - shift / 2}px)`,
		right: MARGIN_GAP + lane,
	};
}

/** The card's lane the block's room declares (globals.css .lh-room-dock),
 *  in px; 0 without room. */
export function roomLane(style: CSSStyleDeclaration): number {
	return parseFloat(style.getPropertyValue?.("--lh-room-lane") ?? "") || 0;
}

/** The block's flank, measured live (its computed padding follows the
 *  make-room container query). */
export function measureDockFlank(block: HTMLElement): DockFlank {
	const style = getComputedStyle(block);
	return dockFlank(block.offsetWidth, parseFloat(style.paddingLeft) || 0, parseFloat(style.paddingRight) || 0, DOCK_W, roomLane(style));
}
