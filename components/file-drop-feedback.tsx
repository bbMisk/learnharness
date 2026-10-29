"use client";

import { FileIcon } from "lucide-react";
import type { useFileDrop } from "@/components/file-drop";

/** The draft remains the attachment's source of truth; removal deletes its path. */
export function FileDropFeedback({ files }: { files: ReturnType<typeof useFileDrop> }) {
	return <div className="px-2.5">
		{files.previews.length > 0 && <div className="flex flex-wrap gap-2 py-2">
			{files.previews.map((file) => <div key={file.url} className="relative rounded-md border p-1">
				{/* Blob URLs preview the exact bytes being uploaded, including remote clipboard images. */}
				{/* eslint-disable-next-line @next/next/no-img-element */}
				{file.image ? <img src={file.url} alt={file.name} className="h-20 max-w-40 rounded object-contain" /> : <div className="flex max-w-56 items-center gap-2 px-2 py-3 text-sm"><FileIcon className="size-5 shrink-0 text-muted-foreground" /><span className="truncate" title={file.name}>{file.name}</span></div>}
				<button type="button" aria-label={`Remove ${file.name}`} onClick={(e) => { e.stopPropagation(); files.remove(file.path); }} className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full border bg-background text-sm">×</button>
			</div>)}
		</div>}
		{files.uploading && <p role="status" className="py-1 text-xs text-muted-foreground">Adding files…</p>}
		{files.error && <p role="alert" className="py-1 text-xs text-destructive">{files.error}</p>}
	</div>;
}
