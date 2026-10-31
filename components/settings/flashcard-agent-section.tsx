"use client";
import { useEffect, useState } from "react";
import type { AgentSettings } from "@/src/core";
import { useActivity } from "@/components/activity-dock";
import { SettingsGroup, SettingsRow, Toggle, CommitInput } from "./controls";

interface AgentStatus {running:boolean;phase:string;preparedToday:number;startedToday:number;dailyLimit:number;error:string|null;model:string|null;projects?:Array<{id:string;name:string;preparedToday:number;startedToday:number}>}
export function FlashcardAgentSection({agent,onChange}:{agent:AgentSettings|undefined;onChange:(next:AgentSettings)=>void}) {
    const [status,setStatus]=useState<AgentStatus|null>(null);
    const [error,setError]=useState("");
    const [instructions,setInstructions]=useState(agent?.flashcards?.instructions??"");
    const [requesting,setRequesting]=useState(false);
    const refresh=()=>{void fetch("/api/flashcard-agent").then(r=>r.ok?r.json():null).then(value=>{if(value)setStatus(value);}).catch(()=>{});};
    const {feed}=useActivity();
    useEffect(refresh,[feed]);
    useEffect(()=>setInstructions(agent?.flashcards?.instructions??""),[agent?.flashcards?.instructions]);
    const settings=agent?.flashcards;
    const change=(next:NonNullable<AgentSettings["flashcards"]>)=>onChange({...agent,flashcards:{...settings,...next}});
    const action=async(method:"POST"|"DELETE")=>{
        setRequesting(true);setError("");
        try {const response=await fetch("/api/flashcard-agent",{method});if(!response.ok)throw new Error("Could not update flashcard preparation.");refresh();}
        catch(error){setError(error instanceof Error?error.message:"Could not update preparation.");}
        finally{setRequesting(false);}
    };
    return <SettingsGroup label="Flashcard curator" testid="group-flashcard-agent">
        <SettingsRow label="Automatic flashcards" hint="Triage extracted concepts and prepare multiple-choice questions in the background. Uses the Cheap model." testid="row-flashcard-agent-enabled">
            <Toggle label="automatic flashcards" checked={settings?.enabled!==false} onChange={enabled=>change({enabled})}/>
        </SettingsRow>
        <SettingsRow label="New concepts per project per day" hint="Each project has its own allowance. Chats outside a project share an Unassigned allowance. Resets at 4am New York time." testid="row-flashcard-agent-limit">
            <CommitInput type="number" value={String(settings?.dailyLimit??20)} ariaLabel="automatic flashcard daily limit" testid="input-flashcard-agent-limit" onCommit={value=>{const n=Number(value);if(Number.isInteger(n)&&n>=1&&n<=100)change({dailyLimit:n});}}/>
        </SettingsRow>
        <div className="space-y-2 py-3">
            <label htmlFor="flashcard-curator-instructions" className="text-sm font-medium">Curation guidance</label>
            <p className="text-xs text-muted-foreground">Prioritize ideas you want to remember. The agent skips duplicates, logistics and uncertain claims, and follows your Flashcard sources setting.</p>
            <textarea id="flashcard-curator-instructions" aria-label="Flashcard curator instructions" rows={3} maxLength={8000} value={instructions} onChange={event=>setInstructions(event.target.value)} placeholder="For example: prioritize definitions, physical intuition, and mistakes I made." className="lh-input w-full resize-y rounded-lg border bg-background p-3 text-sm"/>
            <button type="button" disabled={instructions===(settings?.instructions??"")} onClick={()=>change({instructions})} className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50">Save guidance</button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 py-3">
            <div role="status" className="text-xs text-muted-foreground">{status?.running?status.phase:status?`${status.preparedToday} prepared today · up to ${status.dailyLimit} per project` : "Loading preparation status…"}{status?.projects?.map(project=><span key={project.id} className="mt-1 block">{project.name}: {project.preparedToday} prepared · {project.startedToday}/{status.dailyLimit} slots used</span>)}{status?.model&&<span className="mt-1 block">{status.model}</span>}</div>
            <button type="button" disabled={requesting||settings?.enabled===false} onClick={()=>void action(status?.running?"DELETE":"POST")} className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50">{status?.running?"Stop preparation":"Prepare now"}</button>
        </div>
        {(error||status?.error)&&<p role="alert" className="text-xs text-muted-foreground">{error||status?.error}</p>}
    </SettingsGroup>;
}
