"use client";
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRightIcon, FileIcon, FolderIcon, MessageSquareIcon, PaperclipIcon, PlusIcon, XIcon } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { sessionMeta } from '@/components/sidebar';
import { TopBar } from '@/components/top-bar';
import { startChatDrag, useChatDrop } from '@/components/chat-drag';
import { useFileDrop } from '@/components/file-drop';
import { FileDropFeedback } from '@/components/file-drop-feedback';
import { useServerEvent, useServerResync } from '@/components/server-events';
import type { ChatListItem, ProjectView } from '@/src/core';
export function ProjectPage({ initial }: {
    initial: ProjectView;
}) {
    type Field = "name" | "instructions";
    const [project, setProject] = useState(initial);
    const [edits, setEdits] = useState<Partial<Record<Field, { value: string; expected: string }>>>({});
    const [conflicts, setConflicts] = useState<Field[]>([]);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);
    const [saving, setSaving] = useState(false);
    const [moveStatus, setMoveStatus] = useState("");
    const [tab, setTab] = useState("chats");
    const chatDrop = useChatDrop(id => {
        setMoveStatus("Moving chat…"); setError("");
        void fetch("/api/chats/" + id, {method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify({projectId:initial.id})}).then(async response => {
            if (!response.ok) throw new Error("Could not move chat. Try again.");
            await refresh(); setMoveStatus("Chat moved to " + project.name + ".");
        }).catch(error => { setMoveStatus(""); setError(error.message); });
    });
    const [chats, setChats] = useState<ChatListItem[] | null>(null);
    const [chatsError, setChatsError] = useState("");
    const adopt = (next: ProjectView) => setProject(prev => next.updatedAt >= prev.updatedAt ? next : prev);
    const refresh = async () => {
        await Promise.all([
        fetch('/api/chats').then(r => r.ok ? r.json() : Promise.reject(new Error(r.statusText))).then(body => {
            setChats((body.chats || []).filter((chat: ChatListItem) => chat.projectId === initial.id && !chat.archived));
            setChatsError('');
        }).catch(() => setChatsError('Could not load chats.')),
        fetch('/api/projects/' + initial.id).then(r => r.ok ? r.json() : null).then(next => { if (next) adopt(next); }).catch(() => {})]);
    };
    useEffect(() => { void refresh(); }, [initial.id]);
    useServerEvent('chats-changed', refresh);
    useServerEvent('turn-started', refresh);
    useServerEvent('turn-settled', refresh);
    useServerResync(refresh);
    const change = (field: Field, value: string) => {
        setSaved(false);
        setEdits(prev => {
            const next = {...prev};
            if (value === project[field]) delete next[field];
            else next[field] = {value, expected: prev[field]?.expected ?? project[field]};
            return next;
        });
    };
    const save = async (updates: object) => {
        const response = await fetch('/api/projects/' + initial.id, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(updates)});
        const result = await response.json();
        if (response.status === 409) { adopt(result.project); setConflicts(result.conflicts); }
        if (!response.ok) throw new Error(result.error || 'Could not save project.');
        adopt(result);
    };
    const saveText = async () => {
        setSaving(true); setError(''); setConflicts([]);
        try {
            await save({ ...Object.fromEntries(Object.entries(edits).map(([key, edit]) => [key, edit.value])), expected: Object.fromEntries(Object.entries(edits).map(([key, edit]) => [key, edit.expected])) });
            setEdits({}); setSaved(true);
        } catch (error) { setError(error instanceof Error ? error.message : 'Could not save project.'); }
        finally { setSaving(false); }
    };
    const resolveConflict = (keep: boolean) => {
        setEdits(prev => {
            const next = {...prev};
            for (const field of conflicts) {
                if (keep && next[field]) next[field] = {...next[field], expected:project[field]};
                else delete next[field];
            }
            return next;
        });
        setConflicts([]); setError('');
    };
    const name = edits.name?.value ?? project.name;
    const instructions = edits.instructions?.value ?? project.instructions;
    const files = useFileDrop('', () => { }, { uploadAll: true, priority: 50, label: 'project files', activate: () => setTab('files'), onUploaded: async (path) => { const id = path.match(/\/uploads\/([0-9a-f-]{36})\/file\//)?.[1]; if (!id)
            throw new Error('The file could not be added to this project.'); await save({ addFileIds: [id] }); } });
    const tabClass = "flex items-center gap-2 rounded-md px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground data-[state=active]:bg-accent data-[state=active]:text-foreground";
    const buttonClass = "inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs transition-colors hover:bg-accent disabled:opacity-40";
    return <div {...chatDrop.handlers} data-project-page-drop={project.id} className="relative flex h-dvh flex-col">
        {chatDrop.over && <div className="pointer-events-none absolute inset-4 z-20 flex items-center justify-center rounded-xl bg-accent/90 text-sm backdrop-blur-sm">Move chat to {project.name}</div>}
        <TopBar>
            <span className="text-xs text-muted-foreground">Projects</span><span className="text-xs text-muted-foreground/50">/</span><span className="truncate text-sm">{project.name}</span>
            <span className="flex-1"/>
            <Link href={'/chat/new?project=' + project.id} className={buttonClass}><PlusIcon className="size-3.5"/>New chat</Link>
        </TopBar>
        <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-5xl px-6 py-10 md:px-12 md:py-12">
                <header className="mb-8">
                    <div className="mb-3 flex items-center gap-3"><FolderIcon className="size-6 shrink-0 text-muted-foreground"/><h1 className="min-w-0 break-words font-prose text-3xl font-semibold tracking-tight">{project.name}</h1></div>
                    <p className="font-prose text-base text-muted-foreground">A shared space for your conversations, reference files, and tutor instructions.</p>
                </header>
                {moveStatus && <p role="status" className="mb-4 text-xs text-muted-foreground">{moveStatus}</p>}
                {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
                {!!conflicts.length && <div className="mb-4 flex gap-4 text-xs"><button onClick={() => resolveConflict(false)} className="underline">Use saved version</button><button onClick={() => resolveConflict(true)} className="underline">Keep my edits</button></div>}
                <Tabs.Root value={tab} onValueChange={setTab}>
                    <Tabs.List aria-label="Project sections" className="mb-6 flex flex-wrap gap-1 border-b border-border/50 pb-3">
                        <Tabs.Trigger value="chats" className={tabClass}>Chats <span className="text-muted-foreground">{chats?.length ?? '—'}</span></Tabs.Trigger>
                        <Tabs.Trigger value="files" className={tabClass}>Files <span className="text-muted-foreground">{project.files.length}</span></Tabs.Trigger>
                        <Tabs.Trigger value="instructions" className={tabClass}>Instructions</Tabs.Trigger>
                    </Tabs.List>
                    <Tabs.Content value="chats" forceMount className="data-[state=inactive]:hidden">
                        <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="text-xs uppercase tracking-widest text-muted-foreground">Project chats</h2><p className="text-xs text-muted-foreground">Drag a chat here to add it to this project.</p></div>
                        <div className="space-y-1">
                            {chats?.map(chat => <Link key={chat.id} draggable onDragStart={event => startChatDrag(event, chat.id)} href={'/chat/' + chat.id} className="group flex items-center gap-3 rounded-lg px-3 py-4 transition-colors hover:bg-accent/60">
                                <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground"/>
                                <span className="min-w-0 flex-1"><span className="block truncate font-prose text-lg">{chat.title}</span><span className="mt-1 block text-xs text-muted-foreground sm:hidden">{sessionMeta(chat)}</span></span>
                                <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{sessionMeta(chat)}</span>
                                <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"/>
                            </Link>)}
                        </div>
                        {chatsError && <p role="alert" className="py-2 text-xs text-destructive">{chatsError}</p>}
                        {chats === null && !chatsError && <p className="py-8 text-xs text-muted-foreground">Loading chats…</p>}
                        {chats?.length === 0 && <div className="py-12 text-center"><MessageSquareIcon className="mx-auto mb-4 size-6 text-muted-foreground"/><h2 className="font-prose text-xl">Start a conversation in {project.name}</h2><p className="mt-2 font-prose text-base text-muted-foreground">Every chat here can use this project’s files and instructions.</p><Link href={'/chat/new?project=' + project.id} className={buttonClass + " mt-5 bg-accent"}><PlusIcon className="size-3.5"/>New chat</Link></div>}
                    </Tabs.Content>
                    <Tabs.Content value="files" forceMount className="data-[state=inactive]:hidden">
                        <div {...files.handlers}>
                            <div className="mb-6 flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xs uppercase tracking-widest">Shared files</h2><p className="mt-2 font-prose text-base text-muted-foreground">Reference material available to every chat in this project.</p></div><button type="button" disabled={files.uploading} onClick={() => files.inputRef.current?.click()} className={buttonClass + " bg-accent"}><PaperclipIcon className="size-3.5"/>Add files</button><input ref={files.inputRef} type="file" multiple hidden onChange={event => { const incoming = Array.from(event.target.files || []); event.target.value = ''; void files.addFiles(incoming); }}/></div>
                            {!project.files.length && <div className="rounded-lg bg-card/50 px-6 py-10 text-center"><PaperclipIcon className="mx-auto mb-3 size-5 text-muted-foreground"/><p className="font-prose text-lg">Drop files here, or choose Add files.</p><p className="mt-2 font-prose text-sm text-muted-foreground">Add notes, readings, or problem sets for the tutor to reference.</p></div>}
                            {project.missingFileIds?.map(id => <div key={id} className="flex items-center gap-3 py-3 text-sm"><span className="flex-1 text-muted-foreground">File unavailable. Remove it and upload it again.</span><button type="button" aria-label="Remove unavailable file" onClick={() => void save({ removeFileIds: [id] }).catch(error => setError(error.message))} className={buttonClass}><XIcon className="size-4"/></button></div>)}
                            <div className="space-y-1">{project.files.map(file => <div key={file.id} className="group flex items-center gap-3 rounded-lg px-3 py-3 hover:bg-accent/40"><FileIcon className="size-4 shrink-0 text-muted-foreground"/><a className="min-w-0 flex-1 truncate font-prose text-base hover:underline" href={file.url}>{file.name}</a><span className="text-xs text-muted-foreground">{Math.max(1,Math.round(file.size/1024))} KB</span><button type="button" aria-label={'Remove ' + file.name} onClick={() => void save({ removeFileIds: [file.id] }).catch(error => setError(error.message))} className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"><XIcon className="size-3.5"/></button></div>)}</div>
                            <FileDropFeedback files={files}/>
                        </div>
                    </Tabs.Content>
                    <Tabs.Content value="instructions" forceMount className="data-[state=inactive]:hidden">
                        <div className="mb-6"><h2 className="text-xs uppercase tracking-widest">Tutor instructions</h2><p className="mt-2 font-prose text-base text-muted-foreground">Tell the tutor how to work with you across every chat in this project.</p></div>
                        <form onSubmit={event => { event.preventDefault(); void saveText(); }}><fieldset disabled={saving} className="space-y-5">
                            <label className="block text-xs text-muted-foreground">Instructions<textarea aria-label="Project instructions" value={instructions} onChange={event => change("instructions",event.target.value)} placeholder="For example: build physical intuition first, then derive the equations. Use the uploaded course notes." maxLength={32000} rows={8} className="lh-input mt-2 w-full resize-y rounded-lg border border-border/60 bg-card/50 p-4 font-prose text-lg text-foreground"/></label>
                            <details><summary className="cursor-pointer text-xs text-muted-foreground">Rename project</summary><label className="mt-4 block text-xs text-muted-foreground">Project name<input aria-label="Project name" value={name} onChange={event => change("name",event.target.value)} maxLength={200} className="lh-input mt-2 w-full rounded-lg border border-border/60 bg-card/50 p-3 font-prose text-base text-foreground"/></label></details>
                            <div className="flex items-center gap-3"><button disabled={saving || !name.trim() || !Object.keys(edits).length} className={buttonClass + " bg-accent text-foreground"}>{saving ? 'Saving…' : 'Save changes'}</button>{saved && <span role="status" className="text-xs text-muted-foreground">Saved</span>}</div>
                        </fieldset></form>
                    </Tabs.Content>
                </Tabs.Root>
            </div>
        </div>
    </div>;
}
