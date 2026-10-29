"use client";
import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { FolderIcon, PlusIcon } from 'lucide-react';
import { Dialog } from 'radix-ui';
import type { ProjectSummary } from '@/src/core';
export function ProjectSidebar({projects, refresh}: {projects: ProjectSummary[]; refresh: () => void}) {
    const [open, setOpen] = useState(false), [name, setName] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
    const router = useRouter(), pathname = usePathname();
    const create = async () => { if (!name.trim() || saving)
        return; setSaving(true); setError(''); try {
        const r = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        const body = await r.json();
        if (!r.ok)
            throw new Error(body.error);
        setOpen(false);
        setName('');
        refresh();
        router.push('/project/' + body.id);
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Could not create project.');
    }
    finally {
        setSaving(false);
    } };
    return <section className="mx-3 mb-3" aria-label="Projects">
  <div className="mb-1 flex items-center justify-between px-2 text-xs text-muted-foreground"><span>Projects</span><button type="button" aria-label="Add project" onClick={() => setOpen(true)} className="rounded p-1 hover:bg-accent"><PlusIcon className="size-3.5"/></button></div>
  {projects.map(project => <div key={project.id} className={`group flex items-center rounded-md ${pathname === '/project/' + project.id ? 'bg-accent' : ''}`}><Link href={'/project/' + project.id} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 font-prose text-sm"><FolderIcon className="size-4 shrink-0 text-muted-foreground"/><span className="truncate">{project.name}</span></Link><Link href={'/chat/new?project=' + project.id} aria-label={'New chat in ' + project.name} className="mr-1 rounded p-1 text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100 focus:opacity-100"><PlusIcon className="size-3.5"/></Link></div>)}
  <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/><Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 w-[min(90vw,420px)] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-2xl border bg-card p-6 shadow-xl"><Dialog.Title className="text-sm font-semibold">New project</Dialog.Title><form onSubmit={e => { e.preventDefault(); void create(); }} className="space-y-4"><input aria-label="Project name" value={name} onChange={e => setName(e.target.value)} autoFocus maxLength={200} placeholder="Project name" className="lh-input w-full rounded-lg border bg-background p-3"/>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<button disabled={!name.trim() || saving} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">Create project</button></form><Dialog.Close className="absolute right-4 top-3 text-muted-foreground" aria-label="Close new project">×</Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
 </section>;
}
