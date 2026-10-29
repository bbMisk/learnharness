"use client";
import { useEffect, useState } from "react";
import { SettingsRow } from "./controls";

/** Device-local launcher configuration; never written into the host's settings. */
export function ConnectionSettings() {
	const [connection, setConnection] = useState<{ mode: string; url: string } | null>(null);
	useEffect(() => { void window.lh?.getConnection?.().then(setConnection); }, []);
	if (!connection) return null;
	return <SettingsRow label="Connection" hint={connection.mode === "host" ? connection.url : "Using this Mac"} testid="row-connection">
		<button type="button" onClick={() => window.lh?.openConnection?.()} className="rounded-sm border border-border px-3 py-1.5 text-xs hover:bg-accent">Change…</button>
	</SettingsRow>;
}
