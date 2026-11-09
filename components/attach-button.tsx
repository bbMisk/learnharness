"use client";

import { useEffect, useRef, useState } from "react";
import { PaperclipIcon } from "lucide-react";
import { MenuShell } from "@/components/menu-shell";
import type { useFileDrop } from "@/components/file-drop";

/** The composer paperclip. On the local desktop app it opens a two-item menu
 *  (Files… / Folder…); everywhere else it opens the file chooser directly. */
export function AttachButton({ fileDrop }: { fileDrop: ReturnType<typeof useFileDrop> }) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element;
			if (target instanceof Element && target.closest('[data-testid="attach-menu"]')) return;
			if (!triggerRef.current?.contains(target)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			triggerRef.current?.focus();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [open]);
	const item = "rounded-lg px-2 py-1.5 text-left text-card-foreground transition-colors hover:bg-muted";
	return (
		<>
			<input ref={fileDrop.inputRef} type="file" multiple className="hidden" aria-label="Choose files" onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ""; void fileDrop.addFiles(files); }} />
			<button
				ref={triggerRef}
				type="button"
				data-testid="attach-button"
				aria-label="Add files"
				aria-expanded={open}
				title={fileDrop.uploading ? "Uploading…" : "Add files"}
				disabled={fileDrop.uploading}
				onClick={() => (fileDrop.canAddFolder() ? setOpen((o) => !o) : fileDrop.inputRef.current?.click())}
				className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
			>
				<PaperclipIcon className="size-4" />
			</button>
			{open && (
				<MenuShell anchorRef={triggerRef} testid="attach-menu" preferredSide="up" align="left" menuClass="flex w-32 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl">
					<button type="button" data-testid="attach-files" className={item} onClick={() => { setOpen(false); fileDrop.inputRef.current?.click(); }}>Files…</button>
					<button type="button" data-testid="attach-folder" className={item} onClick={() => { setOpen(false); void fileDrop.addFolder(); }}>Folder…</button>
				</MenuShell>
			)}
		</>
	);
}
