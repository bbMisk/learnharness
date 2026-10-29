"use client";

import { useEffect, useId, useRef, useState } from "react";
import { registerFileDrop, focusFileDrop } from "@/components/global-file-drop";
import type { ClipboardEvent } from "react";

/** Resolve native Files, never substitute a basename for an unavailable path. */
export function droppedFilePaths(files: Iterable<File>, resolve: (file: File) => string): string[] {
	return [...new Set(Array.from(files, resolve).filter(Boolean))];
}

/** One quoted path per line keeps spaces and unusual filenames unambiguous. */
export function appendFilePaths(draft: string, paths: string[]): string {
	if (!paths.length) return draft;
	return `${draft}${draft && !draft.endsWith("\n") ? "\n" : ""}${paths.map((p) => JSON.stringify(p)).join("\n")}`;
}

/** Clipboard screenshots are memory-backed Files, even in Electron. */
export async function resolveFilePaths(files: File[], native?: (file: File) => string, upload = uploadFile): Promise<string[]> {
	const paths: string[] = [];
	for (const file of files) {
		let path = "";
		try { path = native?.(file) || ""; } catch { /* No native path: upload the bytes. */ }
		paths.push(path || await upload(file));
	}
	return [...new Set(paths)];
}

async function uploadFile(file: File): Promise<string> {
	if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} exceeds the 50 MiB limit.`);
	const response = await fetch(`/api/files?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
	const result = await response.json();
	if (!response.ok || typeof result.path !== "string") throw new Error(result.error || "Upload failed.");
	return result.path;
}

export interface FilePreview { path: string; name: string; url: string; image: boolean }

export interface FileDropOptions { onUploadingChange?: (busy: boolean) => void; hideImagePaths?: boolean; imagesOnly?: boolean; uploadAll?: boolean; priority?: number; label?: string; activate?: () => void; onUploaded?: (path: string) => Promise<void> }
export function useFileDrop(value: string, onChange: (value: string) => void, options: FileDropOptions = {}) {
 const {onUploadingChange,hideImagePaths=false,imagesOnly=false,uploadAll=false}=options;
 const id=useId();
	const [error, setError] = useState("");
	const [uploading, setUploading] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const [previews, setPreviews] = useState<FilePreview[]>([]);
	const resources = useRef<string[]>([]);
	const pending = useRef(0);
	const queue = useRef(Promise.resolve());
	const mounted = useRef(true);
	const latest = useRef({ value, onChange });
	useEffect(() => { latest.current = { value, onChange }; }, [value, onChange]);
	useEffect(() => {
		const removed = previews.filter((item) => !value.includes(JSON.stringify(item.path)));
		if (!removed.length) return;
		const urls = new Set(removed.map((item) => item.url));
		urls.forEach((url) => URL.revokeObjectURL(url));
		resources.current = resources.current.filter((url) => !urls.has(url));
		setPreviews((items) => items.filter((item) => !urls.has(item.url)));
	}, [value, previews]);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			resources.current.forEach((url) => URL.revokeObjectURL(url));
			onUploadingChange?.(false);
		};
	}, [onUploadingChange]);
	const addFiles = (files: File[]) => {
		if (!files.length) return Promise.resolve();
		pending.current++;
		setUploading(true); onUploadingChange?.(true);
		queue.current = queue.current.then(async () => {
			if (!mounted.current) return;
			setError("");
			try {
				for (const file of files) {
					if (imagesOnly && !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error("The side tutor supports PNG, JPEG, WebP and GIF images.");
					// Disk-backed images also use the upload store so every chat can attach their bytes.
					const image = /^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type);
					const [path] = await resolveFilePaths([file], image || uploadAll || window.lh?.remoteServer ? undefined : window.lh?.getPathForFile);
					if (!path) throw new Error("File could not be added.");
					if (!mounted.current) return;
					await options.onUploaded?.(path);
					const next = appendFilePaths(latest.current.value, [path]);
					latest.current.onChange(next);
					latest.current.value = next;
					const url = URL.createObjectURL(file);
					resources.current.push(url);
					setPreviews((items) => [...items, { path, name: file.name, url, image }]);
				}
			} catch (error) {
				if (mounted.current) setError(error instanceof Error ? error.message : "Files could not be added.");
			} finally {
				pending.current--;
				if (mounted.current && !pending.current) { setUploading(false); onUploadingChange?.(false); }
			}
		});
		return queue.current;
	};
 const registered=useRef({addFiles,options});registered.current={addFiles,options};
 useEffect(()=>registerFileDrop({id,label:()=>registered.current.options.label||'the message',priority:()=>registered.current.options.priority??10,element:()=>document.querySelector(`[data-file-drop-id=${JSON.stringify(id)}]`),activate:()=>registered.current.options.activate?.(),canReveal:()=>!!registered.current.options.activate,add:(files)=>registered.current.addFiles(files)}),[id]);
	const removePath = (draft: string, path: string) => draft.replaceAll(`\n${JSON.stringify(path)}`, "").replaceAll(JSON.stringify(path), "");
	const visibleText = (draft: string) => hideImagePaths ? previews.reduce((text, item) => removePath(text, item.path), draft) : draft;
	return {
		text: visibleText(value),
		currentText: () => visibleText(latest.current.value),
		changeText(text: string) {
			const paths = hideImagePaths ? previews.filter((item) => latest.current.value.includes(JSON.stringify(item.path))).map((item) => item.path) : [];
			const next = appendFilePaths(text, [...new Set(paths)]);
			latest.current.value = next;
			latest.current.onChange(next);
		},
		error,
		uploading,
		isUploading: () => pending.current > 0,
		previews: previews.filter((item) => value.includes(JSON.stringify(item.path))),
		remove(path: string) {
			const next = removePath(latest.current.value, path);
			latest.current.value = next;
			latest.current.onChange(next);
		},
		inputRef,
		addFiles,
		handlers: {
			"data-file-drop-id": id,
			onFocusCapture() { focusFileDrop(id); },
			onPaste(e: ClipboardEvent<HTMLElement>) {
				const files = Array.from(e.clipboardData.files);
				if (!files.length) for (const item of Array.from(e.clipboardData.items)) { const file = item.kind === "file" ? item.getAsFile() : null; if (file) files.push(file); }
				if (!files.length) return;
				e.preventDefault(); e.stopPropagation(); void addFiles(files);
			},

		},
	};
}
