"use client";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useChatDrop } from "@/components/chat-drag";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronRightIcon, FolderIcon, PlusIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import type { ChatListItem, ProjectSummary } from "@/src/core";
type ProjectChats = {
	chats: ChatListItem[];
	moveChat: (id: string, projectId: string | null) => void;
	renderChat: (chat: ChatListItem) => ReactNode;
	showChats: boolean;
};
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
export function ProjectSidebar({
	projects,
	chats,
	refresh,
	moveChat,
	renderChat,
	showChats,
}: { projects: ProjectSummary[]; refresh: () => void } & ProjectChats) {
	const [open, setOpen] = useState(false),
		[name, setName] = useState(""),
		[error, setError] = useState(""),
		[saving, setSaving] = useState(false);
	const router = useRouter(),
		pathname = usePathname();
	const create = async () => {
		if (!name.trim() || saving) return;
		setSaving(true);
		setError("");
		try {
			const r = await fetch("/api/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name }),
			});
			const body = await r.json();
			if (!r.ok) throw new Error(body.error);
			setOpen(false);
			setName("");
			refresh();
			router.push("/project/" + body.id);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not create project.");
		} finally {
			setSaving(false);
		}
	};
	return (
		<section className="mx-3 mt-2 max-h-[40vh] shrink-0 overflow-y-auto" aria-label="Projects">
			<div className="mb-1 flex h-8 items-center justify-between px-2 text-xs text-muted-foreground">
				<span>Projects</span>
				<button
					type="button"
					aria-label="Add project"
					onClick={() => setOpen(true)}
					className="flex size-6 items-center justify-center rounded hover:bg-accent"
				>
					<PlusIcon className="size-3.5" />
				</button>
			</div>
			{projects.map((project) => (
				<ProjectFolder
					key={project.id}
					project={project}
					active={pathname === "/project/" + project.id}
					chats={chats.filter((chat) => chat.projectId === project.id)}
					moveChat={moveChat}
					renderChat={renderChat}
					showChats={showChats}
				/>
			))}
			<Dialog.Root open={open} onOpenChange={setOpen}>
				<Dialog.Portal>
					<Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
					<Dialog.Content
						aria-describedby={undefined}
						className="fixed left-1/2 top-1/2 z-50 w-[min(90vw,420px)] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-2xl border bg-card p-6 shadow-xl"
					>
						<Dialog.Title className="text-sm font-semibold">New project</Dialog.Title>
						<form
							onSubmit={(e) => {
								e.preventDefault();
								void create();
							}}
							className="space-y-4"
						>
							<input
								aria-label="Project name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								autoFocus
								maxLength={200}
								placeholder="Project name"
								className="lh-input w-full rounded-lg border bg-background p-3"
							/>
							{error && (
								<p role="alert" className="text-sm text-destructive">
									{error}
								</p>
							)}
							<button
								disabled={!name.trim() || saving}
								className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
							>
								Create project
							</button>
						</form>
						<Dialog.Close className="absolute right-4 top-3 text-muted-foreground" aria-label="Close new project">
							×
						</Dialog.Close>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog.Root>
		</section>
	);
}

function ProjectFolder({
	project,
	active,
	chats,
	moveChat,
	renderChat,
	showChats,
}: { project: ProjectSummary; active: boolean } & ProjectChats) {
	const [expanded, setExpanded] = useState(false);
	const storageKey = "lh:project-expanded:" + project.id;
	// Restore before paint; initial rendering never overwrites a saved choice.
	useBrowserLayoutEffect(() => {
		try {
			setExpanded(window.localStorage.getItem(storageKey) === "1");
		} catch {
			/* Storage can be unavailable. */
		}
	}, [storageKey]);
	const rememberExpanded = (next: boolean) => {
		setExpanded(next);
		try {
			window.localStorage.setItem(storageKey, next ? "1" : "0");
		} catch {
			/* Keep the in-memory choice. */
		}
	};
	const drop = useChatDrop((id) => {
		rememberExpanded(true);
		moveChat(id, project.id);
	});
	return (
		<div
			{...drop.handlers}
			data-project-drop={project.id}
			className={`group min-h-11 rounded-md pb-1 transition-colors ${drop.over ? "bg-accent/70" : ""}`}
		>
			<div className={`flex min-h-10 items-center rounded-md transition-colors ${active ? "bg-accent" : "hover:bg-accent/60"}`}>
				<button
					type="button"
					aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
					aria-expanded={expanded && showChats}
					disabled={!showChats}
					onClick={() => rememberExpanded(!expanded)}
					className="rounded p-1 text-muted-foreground hover:bg-accent"
				>
					<ChevronRightIcon className={`size-3 ${expanded ? "rotate-90" : ""}`} />
				</button>
				<Link
					href={"/project/" + project.id}
					aria-label={"Open " + project.name + " project"}
					title="Open project"
					className="flex h-10 w-6 shrink-0 items-center text-muted-foreground transition-colors hover:text-foreground"
				>
					<FolderIcon className="size-4" />
				</Link>
				<button
					type="button"
					aria-expanded={expanded && showChats}
					disabled={!showChats}
					onClick={() => rememberExpanded(!expanded)}
					className="min-w-0 flex-1 truncate py-2 pr-2 text-left font-prose text-(length:--lh-prose-size)"
				>
					{project.name}
				</button>
				<Link
					href={"/chat/new?project=" + project.id}
					aria-label={"New chat in " + project.name}
					className="mr-1 rounded p-1 text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100 focus:opacity-100"
				>
					<PlusIcon className="size-3.5" />
				</Link>
			</div>
			{drop.over && (
				<p role="status" className="sr-only">
					Move chat to {project.name}
				</p>
			)}
			{expanded && showChats && (
				<div className="pl-5 pt-1">
					{chats.map(renderChat)}
					{!chats.length && <p className="px-3 py-2 text-xs text-muted-foreground">No chats yet.</p>}
				</div>
			)}
		</div>
	);
}
