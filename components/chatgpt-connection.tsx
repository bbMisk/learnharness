"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { notifySettingsSaved } from "./settings-signal";

interface Status {
	accounts: { id: string; label: string; connected: boolean; planEnabled: boolean }[];
	active?: string;
	connected: boolean;
	pending: boolean;
	error?: string;
	welcome: boolean;
}

/** Public account metadata only; OAuth credentials stay in the server. */
export function ChatGPTConnection() {
	const [status, setStatus] = useState<Status | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pending = useRef(false);
	const read = useCallback(async () => {
		try {
			const response = await fetch("/api/chatgpt", { cache: "no-store" });
			if (!response.ok) throw new Error("Could not read the ChatGPT connection.");
			const next: Status = await response.json();
			setStatus(next);
			if (pending.current && !next.pending) {
				// Discovery is explicit and errors remain visible on this screen.
				if (next.connected) {
					const result = await fetch("/api/chatgpt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "refresh" }) });
					if (!result.ok) setError((await result.json()).error ?? "Could not load ChatGPT models.");
				}
				if (!next.welcome) notifySettingsSaved("keys");
			}
			pending.current = next.pending;
		} catch (error) { setError(error instanceof Error ? error.message : "Could not connect to the local app."); }
	}, []);
	useEffect(() => { void read(); }, [read]);
	useEffect(() => { if (!status?.pending) return; const timer = setInterval(() => void read(), 2000); return () => clearInterval(timer); }, [read, status?.pending]);

	async function action(action: string, accountId?: string) {
		if (busy) return;
		setBusy(true); setError(null);
		try {
			const response = await fetch("/api/chatgpt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, accountId }) });
			const body = await response.json();
			if (!response.ok) throw new Error(body.error ?? "ChatGPT connection failed.");
			if (action === "connect") {
				// OAuth code and tokens never pass through this origin. Electron
				// sends this OpenAI URL to the user's normal browser.
				window.open(body.url, "_blank", "noopener,noreferrer");
				pending.current = true;
			}
			await read();
			if (action !== "connect") notifySettingsSaved("keys");
		} catch (error) { setError(error instanceof Error ? error.message : "ChatGPT connection failed."); }
		finally { setBusy(false); }
	}

	return <section className="flex flex-col gap-3 rounded-md border border-border p-4 text-sm" aria-label="ChatGPT plan connection">
		<h3 className="font-medium">Use your ChatGPT plan</h3>
		<p className="text-xs text-muted-foreground">Run lessons and background learning tasks using your ChatGPT plan. No API key is needed. Plan limits and any credit permissions you approve in ChatGPT apply.</p>
		{status?.accounts.map((account) => <div key={account.id} className="flex flex-wrap items-center gap-2 text-xs">
			<span>{account.label}{account.id === status.active ? " (active)" : ""}</span>
			{account.connected && account.id !== status.active && <button type="button" className="underline" disabled={busy || status.pending} onClick={() => void action("switch", account.id)}>Use account</button>}
			<button type="button" className="underline" disabled={busy || status.pending} onClick={() => void action("connect", account.id)}>{account.connected ? "Reconnect" : "Continue with ChatGPT"}</button>
			{account.connected && <button type="button" className="underline" disabled={busy || status.pending} onClick={() => void action("disconnect", account.id)}>Sign out</button>}
			{account.connected && !account.planEnabled && <span>ChatGPT plan permission is disabled. Reconnect to enable it.</span>}
		</div>)}
		<div className="flex flex-wrap items-center gap-3">
			<button type="button" disabled={busy || !!status?.pending} onClick={() => void action("connect")} className="rounded-md bg-foreground px-4 py-2 font-medium text-background disabled:opacity-50">Continue with ChatGPT</button>
			{status?.pending && <><span className="text-xs">Finish sign-in in your browser.</span><button type="button" className="text-xs underline" disabled={busy} onClick={() => void action("cancel")}>Cancel</button></>}
			<a className="text-xs underline" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage</a>
			{status?.connected && <button type="button" className="text-xs underline" disabled={busy} onClick={() => void action("refresh")}>Refresh models</button>}
		</div>
		{status?.welcome && <div role="dialog" aria-label="You're using your ChatGPT plan" className="rounded border border-border p-3">
			<p>You’re using your ChatGPT plan</p>
			<p className="mt-1 text-xs text-muted-foreground">Eligible AI requests use your ChatGPT plan. You can manage this app’s usage and access in ChatGPT settings.</p>
			<button type="button" className="mt-2 underline" disabled={busy} onClick={() => void action("welcome")}>Got it</button>
		</div>}
		{(error || status?.error) && <p role="alert" className="text-xs text-red-400">{error || status?.error}</p>}
	</section>;
}
