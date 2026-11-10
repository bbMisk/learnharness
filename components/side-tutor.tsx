"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { XIcon, SquareIcon, ArrowUpIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";
import { ResizableSidePanel } from "@/components/resizable-side-panel";
import { TopBar } from "@/components/top-bar";
import { focusIn, sessionFindHasForegroundLayer, useNewestEscLayer } from "@/components/session-find";
import { useOptionalServerResync } from "@/components/server-events";
import { captureFocus, focusComposer } from "@/components/focus-return";
import { isComposing } from "@/components/ime";
import { Button } from "@/components/ui/button";
import { useFileDrop } from "@/components/file-drop";
import { FileDropFeedback } from "@/components/file-drop-feedback";
import { verbatimInputProps } from "@/components/verbatim-input";
import {
	uploadedImageReferences,
	withoutUploadedImagePaths,
	parseSideJSONResponse,
	kbdEventForAction,
	type SideFrame,
	type SideMessage,
	type SideSnapshot,
} from "@/src/core";

/** Open/close state for the side tutor in a lesson: the toolbar toggle,
 * the keyboard shortcut (focus when open, open otherwise), the close event,
 * and focus return to wherever the learner was before opening. */
export function useSideTutor() {
	const [sideTutor, setSideTutor] = useState<{ selectedText: string } | null>(null);
	const sideReturnFocus = useRef<ReturnType<typeof captureFocus>>(null);
	const closeSideTutor = useCallback((restoreFocus = true) => {
		setSideTutor(null);
		if (restoreFocus) requestAnimationFrame(() => { if (!sideReturnFocus.current?.(true)) focusComposer(); });
	}, []);
	const toggleSideTutor = useCallback(() => {
		if (sideTutor) {
			closeSideTutor();
			return;
		}
		sideReturnFocus.current = captureFocus();
		setSideTutor({ selectedText: window.getSelection()?.toString().slice(0, 8000) ?? "" });
	}, [sideTutor, closeSideTutor]);
	useEffect(() => {
		const event = kbdEventForAction("toggle-side-tutor");
		const focusOrOpen = () => {
			if (sideTutor) {
				const tutor = document.querySelector<HTMLElement>('[data-testid="side-tutor"]');
				(tutor?.querySelector<HTMLTextAreaElement>("textarea:not(:disabled)") ?? tutor)?.focus();
			} else toggleSideTutor();
		};
		window.addEventListener(event, focusOrOpen);
		return () => window.removeEventListener(event, focusOrOpen);
	}, [toggleSideTutor, sideTutor]);
	useEffect(() => {
		const onClose = () => closeSideTutor();
		window.addEventListener("lh:close-side-tutor", onClose);
		return () => window.removeEventListener("lh:close-side-tutor", onClose);
	}, [closeSideTutor]);
	return { sideTutor, toggleSideTutor, closeSideTutor };
}

/** Mounted only while open. No storage, lesson writes, or progress callbacks;
 * closing/unmounting discards the fork and cancels only its own request. */
export function SideTutor({ chatId, selectedText, onClose }: { chatId: string; selectedText: string; onClose: (restoreFocus?: boolean) => void }) {
	const [snapshot, setSnapshot] = useState<SideSnapshot>();
	const [history, setHistory] = useState<SideMessage[]>([]);
	const [draft, setDraft] = useState(selectedText ? `Help me understand this:\n\n${selectedText}` : "");
	const files = useFileDrop(draft, setDraft, { hideImagePaths: true, imagesOnly: true, priority: 5, label: "the side tutor" });
	const [reply, setReply] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const input = useRef<HTMLTextAreaElement>(null);
	const request = useRef<AbortController | null>(null);
	const sendLock = useRef(false);
	// The box is disabled while a reply streams, so focus can only go back once it's enabled again.
	const refocus = useRef(false);
	useEffect(() => {
		if (busy || !refocus.current) return;
		refocus.current = false;
		if (focusIn(input.current?.closest("aside"))) input.current?.focus();
	}, [busy]);
	// A snapshot read that failed (server or network down) retries once either is back.
	const [loadTry, setLoadTry] = useState(0);
	const loadFailed = !snapshot && !!error;
	useOptionalServerResync(() => {
		if (loadFailed) setLoadTry((n) => n + 1);
	});
	useEffect(() => {
		if (!loadFailed) return;
		const retry = () => setLoadTry((n) => n + 1);
		window.addEventListener("online", retry);
		return () => window.removeEventListener("online", retry);
	}, [loadFailed]);
	useEffect(() => {
		const abort = new AbortController();
		setSnapshot(undefined);
		setError("");
		void fetch(`/api/chats/${encodeURIComponent(chatId)}/side`, { signal: abort.signal, cache: "no-store" })
			.then(async (r) => parseSideJSONResponse(await r.text(), r.status) as SideSnapshot)
			.then((s) => {
				setSnapshot(s);
			})
			.catch((e) => {
				if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Could not open the side tutor.");
			});
		return () => {
			abort.abort();
			request.current?.abort();
		};
	}, [chatId, loadTry]);
	useEffect(() => {
		input.current?.focus();
	}, []);
	const newestEsc = useNewestEscLayer(true);
	useEffect(() => {
		const close = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented || isComposing(e) || sessionFindHasForegroundLayer(document) || !newestEsc()) return;
			e.preventDefault();
			e.stopPropagation();
			// Focus the user moved elsewhere (another panel, a field) stays there.
			onClose(focusIn(input.current?.closest("aside")));
		};
		document.addEventListener("keydown", close);
		return () => document.removeEventListener("keydown", close);
	}, [onClose, newestEsc]);

	async function send() {
		const question = draft.trim();
		if (!snapshot || !question || sendLock.current || files.isUploading()) return;
		const abort = new AbortController();
		request.current = abort;
		sendLock.current = true;
		const sent: SideMessage[] = [...history, { role: "user", content: question }];
		setHistory(sent);
		setReply("");
		setError("");
		setBusy(true);
		let answer = "",
			completed = false;
		try {
			const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/side`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				signal: abort.signal,
				body: JSON.stringify({ snapshot, messages: sent }),
			});
			if (!response.ok) parseSideJSONResponse(await response.text(), response.status);
			if (!response.body) throw new Error("The side tutor did not return a stream.");
			const reader = response.body.getReader(),
				decoder = new TextDecoder();
			let buffer = "";
			const apply = (line: string) => {
				if (!line.trim()) return;
				const frame = JSON.parse(line) as SideFrame;
				if (frame.type === "error") throw new Error(frame.error);
				if (frame.type === "delta") {
					answer += frame.text;
					setReply(answer);
				}
				if (frame.type === "done") completed = true;
			};
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) apply(line);
				}
				buffer += decoder.decode();
				if (buffer.trim()) apply(buffer);
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
			if (!completed || !answer.trim()) throw new Error("The response did not finish. Try again.");
			setHistory([...sent, { role: "assistant", content: answer }]);
			setDraft("");
			setReply("");
		} catch (e) {
			setHistory(history);
			setDraft(question);
			setError(abort.signal.aborted ? "Side response stopped." : e instanceof Error ? e.message : "The side tutor could not finish.");
		} finally {
			sendLock.current = false;
			refocus.current = true;
			setBusy(false);
		}
	}

	return (
		<ResizableSidePanel>
			<aside
				aria-label="Temporary side tutor"
				data-testid="side-tutor"
				tabIndex={-1}
				className="flex h-full min-h-0 min-w-0 flex-col border-l border-border bg-background"
				onKeyDown={(e) => {
					if (e.key === "Escape" && sessionFindHasForegroundLayer(document)) return;
					if (e.key === "Escape" && !isComposing(e)) {
						e.preventDefault();
						e.stopPropagation();
						onClose();
					}
					// The lesson's question/field keyboard machine must not see side input.
					else if (!(e.metaKey || e.ctrlKey || e.altKey)) e.stopPropagation();
				}}
			>
				<TopBar showSidebarToggle={false}>
					<span className="min-w-0 flex-1 text-sm font-medium">Side tutor</span>
					<Button variant="ghost" size="icon-sm" aria-label="Close side tutor" onClick={() => onClose()}>
						<XIcon className="size-4" />
					</Button>
				</TopBar>
				<div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
					Temporary · cleared when closed
					{snapshot && (
						<div className="mt-1 truncate" title={`${snapshot.model.id} · ${snapshot.model.thinkingLevel ?? "default"}`}>
							{snapshot.model.id} · {snapshot.model.thinkingLevel ?? "default"}
							{snapshot.truncated ? " · recent lesson context" : " · lesson context"}
						</div>
					)}
				</div>
				<Conversation aria-label="Side conversation" initial="instant" className="min-h-0 flex-1">
					<ConversationContent className="gap-5 p-4">
						{history.length === 0 && !reply && (
							<p className="text-sm text-muted-foreground">
								Ask a question or work through a concept. Your main lesson stays in place.
							</p>
						)}
						{history.map((m, i) => (
							<div key={i} className="min-w-0 text-sm">
								<div className="mb-1 text-xs font-medium uppercase text-muted-foreground">
									{m.role === "user" ? "You" : "Side tutor"}
								</div>
								{m.role === "assistant" ? (
									<MessageResponse>{m.content}</MessageResponse>
								) : (
									<SideUserMessage text={m.content} />
								)}
							</div>
						))}
						{reply && (
							<div data-testid="side-reply" className="min-w-0 text-sm">
								<MessageResponse streaming={busy}>{reply}</MessageResponse>
							</div>
						)}
						{busy && !reply && (
							<p role="status" className="text-sm text-muted-foreground">
								Thinking…
							</p>
						)}
						{error && (
							<p role="alert" className="text-sm text-red-400">
								{error}
							</p>
						)}
					</ConversationContent>
				</Conversation>
				<form
					{...files.handlers}
					className="m-3 rounded-xl border border-border bg-card p-2"
					onSubmit={(e) => {
						e.preventDefault();
						void send();
					}}
				>
					{!busy && <FileDropFeedback files={files} />}
					<textarea
						{...verbatimInputProps}
						ref={input}
						aria-label="Ask the side tutor"
						placeholder={snapshot ? "Ask about this lesson…" : "Loading lesson context…"}
						rows={3}
						maxLength={20_000}
						disabled={busy}
						value={busy ? "" : files.text}
						onChange={(e) => files.changeText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
								e.preventDefault();
								e.stopPropagation();
								void send();
							}
						}}
						className="lh-input w-full resize-none bg-transparent text-sm outline-none disabled:opacity-60"
					/>
					<div className="flex items-center justify-between">
						<span className="text-xs text-muted-foreground">↵ send · ⇧↵ newline</span>
						{busy ? (
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label="Stop side response"
								// React reuses this <button> as Send once the stop re-renders,
								// still inside the click: preventDefault keeps it from submitting.
								onClick={(e) => {
									e.preventDefault();
									request.current?.abort();
								}}
							>
								<SquareIcon className="size-4" />
							</Button>
						) : (
							<Button
								type="submit"
								size="icon-sm"
								aria-label="Send side question"
								disabled={!snapshot || !draft.trim() || files.uploading}
							>
								<ArrowUpIcon className="size-4" />
							</Button>
						)}
					</div>
				</form>
			</aside>
		</ResizableSidePanel>
	);
}

function SideUserMessage({ text }: { text: string }) {
	const images = uploadedImageReferences(text);
	return (
		<div>
			<p className="whitespace-pre-wrap break-words">{withoutUploadedImagePaths(text)}</p>
			{images.map((image) => (
				// eslint-disable-next-line @next/next/no-img-element
				<img
					key={image.id}
					src={image.url}
					alt="Attached screenshot"
					className="mt-2 max-h-64 max-w-full rounded-md border object-contain"
				/>
			))}
		</div>
	);
}
