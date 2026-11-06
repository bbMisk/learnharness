"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

const DEFAULT_WIDTH = 416;
const MIN_SIDE = 288;
const MIN_MAIN = 360;
const WIDTH_KEY = "learnharness.side-tutor-width";

/**
 * A width the user sets by dragging (or arrow keys on) a vertical separator
 * on the panel's LEFT edge, clamped to [minimum, maximum] and remembered per
 * device under `storageKey`. `preferred` is the remembered width before the
 * clamp. Spread `separatorProps` on the separator element.
 */
export function useResizableWidth({ storageKey, defaultWidth, minimum, maximum }: {
	storageKey: string;
	defaultWidth: number;
	minimum: number;
	maximum: number;
}) {
	const [preferred, setPreferred] = useState(defaultWidth);
	const [dragging, setDragging] = useState(false);
	const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
	const latestWidth = useRef(defaultWidth);
	const width = Math.max(minimum, Math.min(preferred, maximum));

	useEffect(() => {
		try {
			const saved = Number(localStorage.getItem(storageKey));
			if (Number.isFinite(saved) && saved > 0) setPreferred(saved);
		} catch {
			/* Browser storage can be disabled; resizing still works. */
		}
	}, [storageKey]);

	const change = (next: number, persist: boolean) => {
		const clamped = Math.max(minimum, Math.min(next, maximum));
		latestWidth.current = clamped;
		setPreferred(clamped);
		if (persist) {
			try {
				localStorage.setItem(storageKey, String(clamped));
			} catch {
				/* Optional preference. */
			}
		}
	};
	const finishDrag = () => {
		if (!drag.current) return;
		drag.current = null;
		setDragging(false);
		change(latestWidth.current, true);
	};

	const separatorProps = {
		role: "separator",
		"aria-orientation": "vertical",
		"aria-valuemin": Math.round(minimum),
		"aria-valuemax": Math.round(maximum),
		"aria-valuenow": Math.round(width),
		tabIndex: 0,
		onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
			if (event.button !== 0) return;
			event.preventDefault();
			event.stopPropagation();
			latestWidth.current = width;
			drag.current = { pointerId: event.pointerId, x: event.clientX, width };
			setDragging(true);
			event.currentTarget.focus({ preventScroll: true });
			event.currentTarget.setPointerCapture(event.pointerId);
		},
		onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
			const start = drag.current;
			if (start?.pointerId === event.pointerId) change(start.width + start.x - event.clientX, false);
		},
		onPointerUp: finishDrag,
		onPointerCancel: finishDrag,
		onLostPointerCapture: finishDrag,
		onDoubleClick: () => change(defaultWidth, true),
		onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
			const next =
				event.key === "ArrowLeft"
					? width + (event.shiftKey ? 64 : 16)
					: event.key === "ArrowRight"
						? width - (event.shiftKey ? 64 : 16)
						: event.key === "Home"
							? minimum
							: event.key === "End"
								? maximum
								: undefined;
			if (next === undefined) return;
			event.preventDefault();
			event.stopPropagation();
			change(next, true);
		},
	} as const;
	return { width, preferred, dragging, separatorProps };
}

/** Local layout only. Children stay mounted throughout dragging and viewport changes. */
export function ResizableSidePanel({ children }: { children: ReactNode }) {
	const panel = useRef<HTMLDivElement>(null);
	const id = useId();
	const [available, setAvailable] = useState<number>();
	const maximum = available === undefined ? DEFAULT_WIDTH : Math.max(0, available - MIN_MAIN);
	const minimum = Math.min(MIN_SIDE, maximum);
	const { width, dragging, separatorProps } = useResizableWidth({ storageKey: WIDTH_KEY, defaultWidth: DEFAULT_WIDTH, minimum, maximum });

	useEffect(() => {
		const parent = panel.current?.parentElement;
		if (!parent) return;
		const measure = () => setAvailable(parent.getBoundingClientRect().width);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(parent);
		return () => observer.disconnect();
	}, []);

	return (
		<div
			ref={panel}
			id={id}
			data-testid="resizable-side-panel"
			style={{ "--side-pane-width": `${width}px` } as CSSProperties}
			className="absolute inset-0 z-40 min-h-0 bg-background md:relative md:inset-auto md:z-auto md:w-[var(--side-pane-width)] md:max-w-[calc(100%-22.5rem)] md:shrink-0"
		>
			<div
				{...separatorProps}
				aria-label="Resize side tutor"
				aria-controls={`${id}-content`}
				title="Drag to resize · double-click to reset"
				data-testid="side-tutor-divider"
				className="lh-no-drag absolute inset-y-0 -left-1 z-50 hidden w-2 touch-none cursor-col-resize select-none outline-none after:absolute after:inset-y-0 after:left-1 after:w-px hover:after:bg-primary/60 focus-visible:after:bg-primary md:block"
			/>
			{dragging && <div aria-hidden="true" className="fixed inset-0 z-40 cursor-col-resize select-none" />}
			<div id={`${id}-content`} className="h-full min-h-0">
				{children}
			</div>
		</div>
	);
}
