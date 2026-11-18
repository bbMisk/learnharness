"use client";
import { useMemo, useRef, type RefObject } from "react";
import { HostDialog } from "@/components/host-dialog";
import type { CloseOutcome } from "@/components/interaction-layers";
import { Button } from "@/components/ui/button";

export function ConnectionRow({ label, action, actionVariant, disabled, onAction, children, testid, actionTestid, labelClassName }: { label: string; action: string; actionVariant?: "outline" | "ghost"; disabled: boolean; onAction: () => void; children?: React.ReactNode; testid?: string; actionTestid?: string; labelClassName?: string }) {
	const variant = actionVariant ?? (action === "Connect" ? "outline" : "ghost");
	return <div className="flex flex-wrap items-center gap-3" data-testid={testid}>
		<span className={labelClassName ?? "font-ui text-xs text-foreground"}>{label}</span>
		{children}
		<Button type="button" size="xs" variant={variant} className={`cursor-pointer disabled:cursor-not-allowed ${variant === "outline" ? "" : "text-muted-foreground hover:text-foreground"}`} data-testid={actionTestid} disabled={disabled} onClick={onAction}>{action}</Button>
	</div>;
}

export function ConnectionFooter({ leading, children, testid }: { leading?: React.ReactNode; children: React.ReactNode; testid?: string }) {
	return <div className="mt-4 flex flex-wrap items-center justify-between gap-3" data-testid={testid}>
		{leading}
		<div className="ml-auto flex flex-wrap items-center justify-end gap-2">{children}</div>
	</div>;
}

/** `initialFocus`: which control takes focus on open; "last" puts a confirm dialog's action under Enter.
 *  A busy dialog stays open (Esc and the backdrop are refused). */
export function ConnectionDialog({ children, onClose, busy, label, testid, backdropTestid, initialFocus = "first" }: { children: React.ReactNode; onClose: () => CloseOutcome | void; busy: boolean; label: string; testid: string; backdropTestid: string; initialFocus?: "first" | "last" }) {
	const ref = useRef<HTMLDivElement>(null);
	// HostDialog portals the frame a commit after mount, so a mount effect would
	// find no buttons. Its explicit initial-focus seam reads the action instead.
	const lastAction = useMemo<RefObject<HTMLElement | null>>(() => ({
		get current() {
			if (initialFocus !== "last") return null;
			return [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])') ?? [])].at(-1) ?? null;
		},
	}), [initialFocus]);
	return <HostDialog open onClose={() => (busy ? "blocked" : onClose() ?? "closed")} aria-label={label} initialFocusRef={lastAction}
		backdropProps={{ className: "fixed inset-0 z-[60] flex items-center justify-center bg-background/80", "data-testid": backdropTestid }}
		frame={<div ref={ref} data-lh-modal aria-busy={busy} data-testid={testid} onClick={(event) => event.stopPropagation()} className="settings-dialog-pop mx-4 max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-md border border-border bg-card p-5 shadow-xl" />}>
		{children}
	</HostDialog>;
}
