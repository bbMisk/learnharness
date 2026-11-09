"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
	type RefObject,
} from "react";
import { Maximize2Icon, Minimize2Icon, PinIcon, PinOffIcon } from "lucide-react";
import { useResizableWidth } from "@/components/resizable-side-panel";
import { focusComposer } from "@/components/focus-return";
import { pinnedJobId, pinTargetOf, type LhViewMessage, type ManualPin, type PinTarget, type TutorPin } from "@/src/core";

/**
 * Shows the pinned demo or diagram (src/core/pinned-visual.ts decides which).
 *
 * Invariant: never reparent or remount the card — moving an iframe reloads
 * it and loses the learner's state. Pinning only restyles the card's
 * wrappers (position: fixed over the docked area) and leaves a same-height
 * placeholder in its transcript row.
 *
 * Docks as a right column when the chat keeps PIN_MIN_CHAT px, else as a
 * right-edge drawer. A demo keeps its transcript width scaled down to fit,
 * not below DEMO_MIN_SCALE; past that it lays out narrower (the demo kit is
 * responsive), down to DEMO_MIN_LAYOUT (or its transcript width, if
 * narrower), after which the panel scrolls.
 */

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export const PIN_DEFAULT_WIDTH = 560;
export const PIN_MIN_WIDTH = 320;
/** The narrowest chat column the dock may leave; below it, the drawer. */
export const PIN_MIN_CHAT = 560;
export const DEMO_MIN_SCALE = 0.7;
export const DEMO_MIN_LAYOUT = 520;
/** The panel's inset from the docked area's edges. */
const GAP = 12;
/** The panel's padding (p-3), subtracted from its client width. */
const PANEL_PAD = 24;
/** The drawer's least height: over a tall check it overlaps the check while open. */
const DRAWER_MIN_H = 420;
/** A folded check's or problem's one-line bar (Enter opens it). */
const FOLDED_BAR = '[data-testid="question-dock-bar"], [data-testid="teach-check-reveal"], [data-testid="practice-dock-bar"]';

export type PinMode = "dock" | "drawer";

/** Dock when the chat column keeps PIN_MIN_CHAT px beside `width`. Pure. */
export function pinMode(areaWidth: number, width: number): PinMode {
	return areaWidth - width >= PIN_MIN_CHAT ? "dock" : "drawer";
}

/** A demo's layout width and scale in a panel `panelWidth` wide, from the
 *  width it has in the transcript (the layout floor never exceeds it: a
 *  phone's demo already lays out narrower). Pure. */
export function demoFit(flowWidth: number, panelWidth: number): { layout: number; scale: number } {
	const layout = Math.max(Math.min(DEMO_MIN_LAYOUT, flowWidth), Math.min(Math.max(flowWidth, panelWidth), panelWidth / DEMO_MIN_SCALE));
	return { layout, scale: Math.max(DEMO_MIN_SCALE, Math.min(1, panelWidth / layout)) };
}

/** Where the pinned card's panel sits, in viewport px. */
export interface PinFrame {
	left: number;
	top: number;
	width: number;
	maxHeight: number;
}

export interface PinnedVisualState {
	pinnedId: string | null;
	/** null while nothing pinned is shown. */
	frame: PinFrame | null;
	/** The drawer is collapsed: the card keeps running, unseen. */
	hidden: boolean;
	expanded: boolean;
	/** The divider is being dragged (the card must not eat the pointer). */
	dragging: boolean;
	zIndex: number;
	pin: (jobId: string) => void;
	unpin: () => void;
	setExpanded: (expanded: boolean) => void;
}

export const PinnedVisualContext = createContext<PinnedVisualState | null>(null);

/** One pinnable card's controls (PinButton / ExpandButton read it). */
interface PinSlot {
	kind: "demo" | "visual";
	pinned: boolean;
	expanded: boolean;
	toggle: () => void;
	toggleExpanded: () => void;
}

const PinSlotContext = createContext<PinSlot | null>(null);

/** Whether the surrounding card is pinned (false outside a chat page). */
export function usePinnedSlot(): boolean {
	return useContext(PinSlotContext)?.pinned === true;
}

/** What the reader is looking at near the scroller's top, and where it is;
 *  null at the bottom (stick-to-bottom keeps the bottom itself). */
function readingAnchor(scroller: HTMLElement | null): { el: Element; top: number } | null {
	if (!scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2) return null;
	const box = scroller.getBoundingClientRect();
	// The text line just under the top edge (a paragraph, not its whole
	// message group: a group rewraps inside itself).
	const hit = document.elementFromPoint?.(box.left + 40, box.top + 40);
	if (hit && hit !== scroller && scroller.contains(hit) && !hit.closest('[data-testid="pin-panel"]')) {
		return { el: hit, top: hit.getBoundingClientRect().top };
	}
	const rows = scroller.querySelector("[data-session-find-root]")?.children ?? [];
	const top = box.top;
	for (const el of rows) {
		const r = el.getBoundingClientRect();
		if (r.bottom > top + 1) return { el, top: r.top };
	}
	return null;
}

interface AreaRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** The session area's viewport rect, kept current. */
function useAreaRect(areaRef: RefObject<HTMLElement | null>): AreaRect | null {
	const [rect, setRect] = useState<AreaRect | null>(null);
	useIsoLayoutEffect(() => {
		const el = areaRef.current;
		if (!el) return;
		const measure = () => {
			const r = el.getBoundingClientRect();
			setRect((prev) =>
				prev && prev.left === r.left && prev.top === r.top && prev.width === r.width && prev.height === r.height
					? prev
					: { left: r.left, top: r.top, width: r.width, height: r.height },
			);
		};
		measure();
		const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		ro?.observe(el);
		window.addEventListener("resize", measure);
		return () => {
			ro?.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [areaRef]);
	return rect;
}

/**
 * The chat page's pin state and chrome. `bottomReserve`: the composer
 * block's height, which the drawer stops above.
 */
export function usePinnedVisual({
	messages,
	tutorPin,
	areaRef,
	bottomReserve,
	getScroller,
}: {
	messages: readonly LhViewMessage[];
	tutorPin: TutorPin | null;
	areaRef: RefObject<HTMLElement | null>;
	bottomReserve: number;
	/** The transcript's scroller (its reading position survives the dock). */
	getScroller: () => HTMLElement | null;
}) {
	const [manual, setManual] = useState<ManualPin | null>(null);
	const pinnedId = pinnedJobId(tutorPin, manual);
	const target = useMemo(() => pinTargetOf(messages, pinnedId), [messages, pinnedId]);
	const area = useAreaRect(areaRef);
	// `preferred` (the remembered width) picks dock or drawer; docked, the
	// divider keeps the chat at least PIN_MIN_CHAT wide.
	const { width, preferred, dragging, separatorProps } = useResizableWidth({
		storageKey: "lh:pin-width",
		defaultWidth: PIN_DEFAULT_WIDTH,
		minimum: PIN_MIN_WIDTH,
		maximum: area ? Math.max(PIN_MIN_WIDTH, area.width - PIN_MIN_CHAT) : PIN_DEFAULT_WIDTH,
	});
	const [open, setOpen] = useState(false);
	const [expanded, setExpanded] = useState(false);

	// A new tutor pin opens the drawer; the one in the record at load does not.
	const tutorCallId = tutorPin?.callId ?? null;
	const seenTutorCall = useRef(tutorCallId);
	useEffect(() => {
		if (tutorCallId === seenTutorCall.current) return;
		seenTutorCall.current = tutorCallId;
		if (tutorCallId) {
			setOpen(true);
			setExpanded(false);
		}
	}, [tutorCallId]);
	const tutorCallRef = useRef(tutorCallId);
	tutorCallRef.current = tutorCallId;
	const pin = useCallback((jobId: string) => {
		setManual({ afterCall: tutorCallRef.current, jobId });
		setOpen(true);
		setExpanded(false);
	}, []);
	const unpin = useCallback(() => {
		setManual({ afterCall: tutorCallRef.current, jobId: null });
		setExpanded(false);
	}, []);

	const mode: PinMode = area ? pinMode(area.width, preferred) : "drawer";
	const drawerWidth = area ? Math.max(Math.min(preferred, area.width - 4 * GAP), 0) : preferred;
	const shown = target !== null && area !== null;
	const showExpanded = shown && expanded;
	let frame: PinFrame | null = null;
	if (shown && showExpanded) {
		frame = { left: area.left + GAP, top: area.top + GAP, width: area.width - 2 * GAP, maxHeight: area.height - 2 * GAP };
	} else if (shown && mode === "dock") {
		frame = { left: area.left + area.width - width + GAP, top: area.top + GAP, width: width - 2 * GAP, maxHeight: area.height - 2 * GAP };
	} else if (shown) {
		frame = {
			left: area.left + area.width - drawerWidth - GAP,
			top: area.top + GAP,
			width: drawerWidth,
			maxHeight: Math.max(area.height - 2 * GAP - bottomReserve, Math.min(DRAWER_MIN_H, area.height - 2 * GAP)),
		};
	}
	const hidden = shown && mode === "drawer" && !open && !showExpanded;
	// A drawer closed by an Esc from inside its demo leaves no focus in the hidden card.
	useEffect(() => {
		const inCard = () => document.activeElement?.closest('[data-testid="pin-slot"][data-pinned]');
		if (!hidden || !inCard()) return;
		focusComposer();
		// No typing field shown (a folded check): its bar takes Enter, else the page does.
		if (inCard()) document.querySelector<HTMLElement>(FOLDED_BAR)?.focus({ preventScroll: true });
		if (inCard()) (document.activeElement as HTMLElement).blur();
	}, [hidden]);

	// Keep the reading position when the dock opens, closes or resizes (the
	// chat rewraps): the anchor is read during render, while the DOM still
	// has the old layout, and restored after commit.
	const dockKey = shown && mode === "dock" ? width : 0;
	const committedDockKey = useRef(dockKey);
	const anchor = useRef<{ el: Element; top: number } | null>(null);
	if (dockKey !== committedDockKey.current && anchor.current === null && typeof window !== "undefined") {
		anchor.current = readingAnchor(getScroller());
	}
	useIsoLayoutEffect(() => {
		committedDockKey.current = dockKey;
		const a = anchor.current;
		anchor.current = null;
		const scroller = getScroller();
		if (a && scroller && a.el.isConnected) scroller.scrollTop += a.el.getBoundingClientRect().top - a.top;
	}, [dockKey, getScroller]);
	const context = useMemo<PinnedVisualState>(
		() => ({
			pinnedId: target?.jobId ?? null,
			frame,
			hidden,
			expanded: showExpanded,
			dragging,
			// Docked sits under the progress card (z-20) so the PROGRESS chip can show it on top.
			zIndex: showExpanded ? 40 : mode === "dock" ? 15 : 30,
			pin,
			unpin,
			setExpanded,
		}),
		// frame is rebuilt each render; its numbers are the dependency.
		[target?.jobId, frame?.left, frame?.top, frame?.width, frame?.maxHeight, hidden, showExpanded, dragging, mode, pin, unpin],
	);

	const dockColumn = shown && mode === "dock" ? (
		<div data-testid="pin-dock" className="relative shrink-0 border-l border-border/80" style={{ width }}>
			<div
				{...separatorProps}
				aria-label="Resize the pinned panel"
				data-testid="pin-divider"
				className={`absolute inset-y-0 -left-1.5 z-20 w-3 cursor-col-resize touch-none outline-none transition-colors hover:bg-border/60 focus-visible:bg-ring/40 ${dragging ? "bg-border/60" : ""}`}
			/>
		</div>
	) : null;

	const toggleDrawer = useCallback(() => setOpen((o) => !o), []);
	const closeExpanded = useCallback(() => setExpanded(false), []);
	// The expanded demo is a modal (data-lh-modal), so the global Esc chain
	// is gated: it claims its own Esc at the document level.
	useEffect(() => {
		if (!showExpanded) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			e.preventDefault();
			e.stopPropagation();
			setExpanded(false);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [showExpanded]);
	// An Esc inside a demo, pinned or not, arrives through its bridge: replay
	// it on the iframe, so it takes one layer as if pressed on the page, in every mode.
	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			if ((e.data as { type?: unknown } | null)?.type !== "demo-escape") return;
			const frames = document.querySelectorAll<HTMLIFrameElement>("iframe");
			[...frames].find((frame) => frame.contentWindow === e.source)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, []);
	const drawerTab = shown && mode === "drawer" && !showExpanded ? (
		<DrawerTab title={target.title} open={open} right={open ? drawerWidth + GAP : 0} onToggle={toggleDrawer} />
	) : null;

	return {
		context,
		target: target as PinTarget | null,
		/** Docked beside the chat: the right column takes the progress card's place. */
		docked: shown && mode === "dock",
		dockColumn,
		drawerTab,
		/** Esc layering inputs (chat.tsx escAbortTarget). */
		escState: { pinExpanded: showExpanded, drawer: shown && mode === "drawer" ? (open ? "open" : "closed") : null } as const,
		closeExpanded,
		toggleDrawer,
	};
}

function DrawerTab({ title, open, right, onToggle }: { title: string; open: boolean; right: number; onToggle: () => void }) {
	return (
		<button
			type="button"
			data-testid="pin-tab"
			aria-expanded={open}
			aria-label={open ? `Hide the pinned ${title}` : `Show the pinned ${title}`}
			title={open ? "Hide (Esc)" : "Show"}
			onClick={onToggle}
			className="absolute top-3 z-30 flex max-h-56 cursor-pointer items-center gap-1.5 rounded-l-lg border border-r-0 border-border/80 bg-card px-1 py-2.5 font-ui text-xs font-medium tracking-wide text-muted-foreground shadow-sm transition-colors [writing-mode:vertical-rl] hover:text-foreground"
			style={{ right }}
		>
			<PinIcon className="size-3.5 shrink-0 rotate-90 text-primary" aria-hidden />
			<span className="truncate">{title}</span>
		</button>
	);
}

const PANEL = "fixed overflow-auto overscroll-contain rounded-xl border border-border/80 bg-background p-3 shadow-lg [scrollbar-gutter:stable]";

/** Wraps a delivered demo or diagram card. Its wrappers render in both
 *  states — pinning only restyles them (the module invariant). */
export function PinnableArtifact({ jobId, kind, children }: { jobId: string; kind: "demo" | "visual"; children: ReactNode }) {
	const pins = useContext(PinnedVisualContext);
	const frame = pins && pins.pinnedId === jobId ? pins.frame : null;
	const pinned = frame !== null;
	const outerRef = useRef<HTMLDivElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	// The row's width (always in flow) and its height while unpinned — the
	// placeholder keeps that height.
	const [flowWidth, setFlowWidth] = useState(0);
	const [flowHeight, setFlowHeight] = useState<number | null>(null);
	useIsoLayoutEffect(() => {
		const el = outerRef.current;
		if (!el) return;
		const measure = () => {
			setFlowWidth(el.offsetWidth);
			if (!pinned) setFlowHeight(el.offsetHeight);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [pinned]);
	// A pinned demo's unscaled height and the panel's inner width.
	const [contentHeight, setContentHeight] = useState(0);
	const [panelWidth, setPanelWidth] = useState(0);
	useIsoLayoutEffect(() => {
		const content = contentRef.current;
		const panel = panelRef.current;
		if (!pinned || kind !== "demo" || !content || !panel) return;
		const measure = () => {
			setContentHeight(content.offsetHeight);
			setPanelWidth(Math.max(panel.clientWidth - PANEL_PAD, 0));
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(measure);
		ro.observe(content);
		ro.observe(panel);
		return () => ro.disconnect();
	}, [pinned, kind]);
	const fit = pinned && kind === "demo" && panelWidth > 0 ? demoFit(flowWidth || panelWidth, panelWidth) : null;

	const pin = pins?.pin;
	const unpin = pins?.unpin;
	const setExpanded = pins?.setExpanded;
	const expanded = pinned && pins?.expanded === true;
	const slot = useMemo<PinSlot | null>(
		() =>
			pin && unpin && setExpanded
				? {
						kind,
						pinned,
						expanded,
						toggle: () => (pinned ? unpin() : pin(jobId)),
						toggleExpanded: () => setExpanded(!expanded),
					}
				: null,
		[pin, unpin, setExpanded, kind, pinned, expanded, jobId],
	);

	const panelStyle: CSSProperties | undefined = frame
		? ({
				left: frame.left,
				top: frame.top,
				width: frame.width,
				maxHeight: frame.maxHeight,
				zIndex: pins!.zIndex,
				visibility: pins!.hidden ? "hidden" : undefined,
				pointerEvents: pins!.hidden || pins!.dragging ? "none" : undefined,
				// The room a pinned diagram may fill: the panel minus its padding
				// and the card's caption row and margins.
				"--lh-pin-h": `${Math.max(frame.maxHeight - 100, 120)}px`,
			} as CSSProperties)
		: undefined;
	return (
		<div
			ref={outerRef}
			data-testid="pin-slot"
			data-pinned={pinned ? "" : undefined}
			className="relative flow-root"
			style={pinned ? { height: flowHeight ?? 56 } : undefined}
		>
			<div ref={panelRef} data-testid="pin-panel" data-lh-modal={expanded ? "" : undefined} className={pinned ? PANEL : undefined} style={panelStyle}>
				<div data-testid="pin-sizer" style={fit ? { width: fit.layout * fit.scale, height: contentHeight * fit.scale, overflow: "hidden" } : undefined}>
					<div ref={contentRef} style={fit ? { width: fit.layout, transform: `scale(${fit.scale})`, transformOrigin: "0 0" } : undefined}>
						<PinSlotContext.Provider value={slot}>{children}</PinSlotContext.Provider>
					</div>
				</div>
			</div>
			{pinned && (
				<div
					data-testid="pin-placeholder"
					className="absolute inset-0 flex items-center justify-center gap-2 rounded-xl border border-dashed border-border/80 font-ui text-xs text-muted-foreground"
				>
					<PinIcon className="size-3.5" aria-hidden />
					{pins?.hidden ? "Pinned in the side drawer" : "Pinned beside the chat"}
					<button type="button" onClick={unpin} className="cursor-pointer rounded-md px-1.5 py-0.5 text-foreground underline-offset-2 hover:underline">
						Unpin
					</button>
				</div>
			)}
		</div>
	);
}

const ICON_BUTTON = "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

/** The card's pin toggle (nothing outside a chat page's transcript). */
export function PinButton() {
	const slot = useContext(PinSlotContext);
	if (!slot) return null;
	const what = slot.kind === "demo" ? "demo" : "figure";
	return (
		<button
			type="button"
			data-testid="pin-toggle"
			aria-pressed={slot.pinned}
			aria-label={slot.pinned ? `Unpin the ${what}` : `Pin the ${what} beside the chat`}
			title={slot.pinned ? "Unpin" : "Pin beside the chat"}
			onClick={slot.toggle}
			className={ICON_BUTTON}
		>
			{slot.pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
		</button>
	);
}

/** A pinned demo's full-area toggle. */
export function ExpandButton() {
	const slot = useContext(PinSlotContext);
	if (!slot?.pinned) return null;
	return (
		<button
			type="button"
			data-testid="pin-expand"
			aria-pressed={slot.expanded}
			aria-label={slot.expanded ? "Shrink the demo back to its panel" : "Expand the demo"}
			title={slot.expanded ? "Shrink (Esc)" : "Expand"}
			onClick={slot.toggleExpanded}
			className={ICON_BUTTON}
		>
			{slot.expanded ? <Minimize2Icon className="size-3.5" /> : <Maximize2Icon className="size-3.5" />}
		</button>
	);
}
