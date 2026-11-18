"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { PaperclipIcon } from "lucide-react";
import { MenuShell } from "@/components/menu-shell";
import { useInteractionLayers } from "@/components/interaction-layers";
import type { useFileDrop } from "@/components/file-drop";

/** The composer paperclip. On the local desktop app it opens a two-item menu
 *  (Files… / Folder…); everywhere else it opens the file chooser directly. */
export function AttachButton({ fileDrop }: { fileDrop: ReturnType<typeof useFileDrop> }) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const close = useCallback(() => setOpen(false), []);
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
			{open && <AttachMenu triggerRef={triggerRef} fileDrop={fileDrop} close={close} />}
		</>
	);
}

/** The open menu, mounted only while open: its single interaction layer (the
 *  menu shell's popup) owns Esc (focus goes back to the paperclip), and an
 *  outside press closes it while that popup is the eligible foreground. A
 *  closed paperclip registers nothing, so it renders anywhere. */
function AttachMenu({ triggerRef, fileDrop, close }: {
	triggerRef: RefObject<HTMLButtonElement | null>;
	fileDrop: ReturnType<typeof useFileDrop>;
	close: () => void;
}) {
	const escape = useCallback(() => { close(); triggerRef.current?.focus(); }, [close, triggerRef]);
	const controller = useInteractionLayers();
	useEffect(() => {
		const outside = (event: PointerEvent) => {
			const menu = controller.getTopLayer();
			if (menu?.kind !== "popup" || menu.anchorRef?.current !== triggerRef.current || !controller.isElementEligible(menu.rootRef.current)) return;
			const target = event.target;
			// The paperclip's own press is its toggle; presses in the menu pick.
			if (!(target instanceof Node) || triggerRef.current?.contains(target) || menu.rootRef.current?.contains(target)) return;
			close();
		};
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [controller, triggerRef, close]);
	const item = "rounded-lg px-2 py-1.5 text-left text-card-foreground transition-colors hover:bg-muted";
	return (
		<MenuShell anchorRef={triggerRef} testid="attach-menu" preferredSide="up" align="left" menuClass="flex w-32 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
			onClose={(reason) => { if (reason === "escape") escape(); else close(); return "closed"; }}>
			<button type="button" data-testid="attach-files" className={item} onClick={() => { close(); fileDrop.inputRef.current?.click(); }}>Files…</button>
			<button type="button" data-testid="attach-folder" className={item} onClick={() => { close(); void fileDrop.addFolder(); }}>Folder…</button>
		</MenuShell>
	);
}
