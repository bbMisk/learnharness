"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

const DEFAULT_WIDTH = 416;
const MIN_SIDE = 288;
const MIN_MAIN = 360;
const WIDTH_KEY = "learnharness.side-tutor-width";

/** Local layout only. Children stay mounted throughout dragging and viewport changes. */
export function ResizableSidePanel({ children }: { children: ReactNode }) {
	const panel = useRef<HTMLDivElement>(null);
	const id = useId();
	const [preferredWidth, setPreferredWidth] = useState(DEFAULT_WIDTH);
	const [available, setAvailable] = useState<number>();
	const [dragging, setDragging] = useState(false);
	const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
	const latestWidth = useRef(DEFAULT_WIDTH);
	const maximum = available === undefined ? DEFAULT_WIDTH : Math.max(0, available - MIN_MAIN);
	const minimum = Math.min(MIN_SIDE, maximum);
	const width = Math.max(minimum, Math.min(preferredWidth, maximum));

	useEffect(() => {
		try {
			const saved = Number(localStorage.getItem(WIDTH_KEY));
			if (Number.isFinite(saved) && saved > 0) setPreferredWidth(saved);
		} catch {
			/* Browser storage can be disabled; resizing still works. */
		}
		const parent = panel.current?.parentElement;
		if (!parent) return;
		const measure = () => setAvailable(parent.getBoundingClientRect().width);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(parent);
		return () => observer.disconnect();
	}, []);

	const change = (next: number, persist: boolean) => {
		const clamped = Math.max(minimum, Math.min(next, maximum));
		latestWidth.current = clamped;
		setPreferredWidth(clamped);
		if (persist) {
			try {
				localStorage.setItem(WIDTH_KEY, String(clamped));
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

	return (
		<div
			ref={panel}
			id={id}
			data-testid="resizable-side-panel"
			style={{ "--side-pane-width": `${width}px` } as CSSProperties}
			className="absolute inset-0 z-40 min-h-0 bg-background md:relative md:inset-auto md:z-auto md:w-[var(--side-pane-width)] md:max-w-[calc(100%-22.5rem)] md:shrink-0"
		>
			<div
				role="separator"
				aria-label="Resize side tutor"
				aria-orientation="vertical"
				aria-controls={`${id}-content`}
				aria-valuemin={Math.round(minimum)}
				aria-valuemax={Math.round(maximum)}
				aria-valuenow={Math.round(width)}
				tabIndex={0}
				title="Drag to resize · double-click to reset"
				data-testid="side-tutor-divider"
				className="lh-no-drag absolute inset-y-0 -left-1 z-50 hidden w-2 touch-none cursor-col-resize select-none outline-none after:absolute after:inset-y-0 after:left-1 after:w-px hover:after:bg-primary/60 focus-visible:after:bg-primary md:block"
				onPointerDown={(event) => {
					if (event.button !== 0) return;
					event.preventDefault();
					event.stopPropagation();
					latestWidth.current = width;
					drag.current = { pointerId: event.pointerId, x: event.clientX, width };
					setDragging(true);
					event.currentTarget.focus({ preventScroll: true });
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={(event) => {
					const start = drag.current;
					if (start?.pointerId === event.pointerId) change(start.width + start.x - event.clientX, false);
				}}
				onPointerUp={finishDrag}
				onPointerCancel={finishDrag}
				onLostPointerCapture={finishDrag}
				onDoubleClick={() => change(DEFAULT_WIDTH, true)}
				onKeyDown={(event) => {
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
				}}
			/>
			{dragging && <div aria-hidden="true" className="fixed inset-0 z-40 cursor-col-resize select-none" />}
			<div id={`${id}-content`} className="h-full min-h-0">
				{children}
			</div>
		</div>
	);
}
