"use client";
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FileIcon, PaperclipIcon, PlusIcon, XIcon } from 'lucide-react';
import { TopBar } from '@/components/top-bar';
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
    const [chats, setChats] = useState<ChatListItem[]>([]);
    const adopt = (next: ProjectView) => setProject(prev => next.updatedAt >= prev.updatedAt ? next : prev);
    const refresh = () => {
        void fetch('/api/chats').then(r => r.json()).then(body => setChats((body.chats || []).filter((chat: ChatListItem) => chat.projectId === initial.id))).catch(() => {});
        void fetch('/api/projects/' + initial.id).then(r => r.ok ? r.json() : null).then(next => { if (next) adopt(next); }).catch(() => {});
    };
    useEffect(refresh, [initial.id]);
    useServerEvent('chats-changed', refresh);
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
    const files = useFileDrop('', () => { }, { uploadAll: true, priority: 50, label: 'project files', onUploaded: async (path) => { const id = path.match(/\/uploads\/([0-9a-f-]{36})\/file\//)?.[1]; if (!id)
            throw new Error('The file could not be added to this project.'); await save({ addFileIds: [id] }); } });
    return <div className="flex h-dvh flex-col"><TopBar><span className="truncate font-medium">{project.name}</span><span className="flex-1"/><Link href={'/chat/new?project=' + project.id} className="lh-no-drag flex items-center gap-2 rounded-md p-1.5 hover:bg-accent"><PlusIcon className="size-4"/>New chat</Link></TopBar>
  <div className="mx-auto w-full max-w-3xl flex-1 space-y-8 overflow-y-auto px-6 py-8 font-prose">
   <section><h1 className="mb-1 text-2xl font-semibold">{project.name}</h1><p className="text-sm text-muted-foreground">Files and instructions are shared with every chat in this project.</p></section>
   <form onSubmit={e => { e.preventDefault(); void saveText(); }}><fieldset disabled={saving} className="space-y-4">
    <label className="block text-sm">Name<input aria-label="Project name" value={name} onChange={e => change("name", e.target.value)} maxLength={200} className="lh-input mt-1 w-full rounded-lg border bg-card p-3"/></label>
    <label className="block text-sm">Instructions<textarea aria-label="Project instructions" value={instructions} onChange={e => change("instructions", e.target.value)} placeholder="What should the tutor know or do in this project?" maxLength={32000} rows={5} className="lh-input mt-1 w-full resize-y rounded-lg border bg-card p-3"/></label>
    <div className="flex items-center gap-3"><button disabled={saving || !name.trim() || !Object.keys(edits).length} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">{saving ? 'Saving…' : 'Save instructions'}</button>{saved && <span role="status" className="text-sm text-muted-foreground">Saved</span>}</div>
   </fieldset></form>
   {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
   {!!conflicts.length && <div className="flex gap-4 text-sm"><button onClick={() => resolveConflict(false)} className="underline">Use saved version</button><button onClick={() => resolveConflict(true)} className="underline">Keep my edits</button></div>}
   <section {...files.handlers} className="rounded-xl border bg-card/40 p-4"><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Files</h2><button type="button" disabled={files.uploading} onClick={() => files.inputRef.current?.click()} className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm hover:bg-accent"><PaperclipIcon className="size-4"/>Add files</button><input ref={files.inputRef} type="file" multiple hidden onChange={e => { const incoming = Array.from(e.target.files || []); e.target.value = ''; void files.addFiles(incoming); }}/></div>
    {!project.files.length && <p className="py-5 text-sm text-muted-foreground">Drop files anywhere in this project to add them.</p>}
    {project.missingFileIds?.map(id => <div key={id} className="flex items-center gap-3 border-t border-border/60 py-3 text-sm"><span className="flex-1 text-muted-foreground">File unavailable. Remove it and upload it again.</span><button type="button" aria-label="Remove unavailable file" onClick={() => void save({ removeFileIds: [id] }).catch(e => setError(e.message))} className="rounded p-1 hover:bg-accent"><XIcon className="size-4"/></button></div>)}
    {project.files.map(file => <div key={file.id} className="flex items-center gap-3 border-t border-border/60 py-3 text-sm"><FileIcon className="size-4 shrink-0 text-muted-foreground"/><a className="min-w-0 flex-1 truncate hover:underline" href={file.url}>{file.name}</a><button type="button" aria-label={'Remove ' + file.name} onClick={() => void save({ removeFileIds: [file.id] }).catch(e => setError(e.message))} className="rounded p-1 hover:bg-accent"><XIcon className="size-4"/></button></div>)}<FileDropFeedback files={files}/>
   </section>
   <section><div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">Chats</h2><Link href={'/chat/new?project=' + project.id} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-accent">New chat</Link></div>{chats.map(chat => <Link key={chat.id} href={'/chat/' + chat.id} className="block rounded-lg px-3 py-3 hover:bg-accent">{chat.title}</Link>)}{!chats.length && <p className="text-sm text-muted-foreground">Start a chat to work with this project.</p>}</section>
  </div>
 </div>;
}
