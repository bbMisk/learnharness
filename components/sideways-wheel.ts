/** A horizontal-only scroller (the header's chip row) turns a vertical mouse
 *  wheel into sideways scrolling; trackpads' own horizontal deltas pass. */
export function sidewaysWheel(e: { deltaX: number; deltaY: number; currentTarget: HTMLElement }): void {
	if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
}
