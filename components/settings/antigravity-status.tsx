"use client";
/** Hanson's fork (docs/antigravity.md): the Antigravity row under Settings → Providers → External CLI.
 *  Renders nothing unless GET /api/antigravity says `available: true` (the server switch is on).
 *  Any other answer, or a failed request, hides it quietly: no throw, no log. */
import { useEffect, useRef, useState } from "react";
import { ANTIGRAVITY_NOT_SIGNED_IN, isAgentVersion, type AntigravityStatus } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { Toggle } from "./controls";

const ENDPOINT = "/api/antigravity";
/** Test seam: how often the row re-reads the status while the server reports a sign-in in progress. */
export const antigravityStatusTimings = { pollMs: 2_000 };
const INTENT = { "x-learnharness-antigravity": "1" };

export function antigravityStatusLabel(status: AntigravityStatus): string {
	if (!status.installed) return "Not installed";
	if (status.problem) return status.problem;
	if (!status.checkedAt) return "Installed · not checked";
	const models = `${status.models} model${status.models === 1 ? "" : "s"}`;
	return `Connected · ${models}${status.agentVersion ? ` · agy ${status.agentVersion}` : ""}`;
}

function isStatus(value: unknown): value is AntigravityStatus {
	const v = value as Partial<AntigravityStatus> | null;
	return !!v && typeof v === "object" && v.available === true && typeof v.enabled === "boolean" && typeof v.installed === "boolean"
		&& typeof v.models === "number" && Number.isSafeInteger(v.models) && v.models >= 0
		&& (v.agentVersion === undefined || isAgentVersion(v.agentVersion))
		&& (v.checkedAt === undefined || typeof v.checkedAt === "string")
		&& (v.problem === undefined || typeof v.problem === "string")
		&& (v.signingIn === undefined || v.signingIn === true);
}


async function call(init: RequestInit & { signal: AbortSignal }): Promise<AntigravityStatus | null> {
	const response = await fetch(ENDPOINT, { cache: "no-store", ...init, headers: { ...INTENT, ...(init.body ? { "Content-Type": "application/json" } : {}) } });
	if (!response.ok) return null;
	const value: unknown = await response.json().catch(() => null);
	return isStatus(value) ? value : null;
}

export function AntigravityProviderStatus() {
	// null: hidden (switch off, unreachable, unreadable, or not loaded yet).
	const [status, setStatus] = useState<AntigravityStatus | null>(null);
	const [busy, setBusy] = useState<"saving" | "checking" | "signingIn" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const pending = useRef<AbortController | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		pending.current = controller;
		call({ signal: controller.signal })
			.then((value) => { if (!controller.signal.aborted) setStatus(value); })
			.catch(() => { if (!controller.signal.aborted) setStatus(null); });
		return () => pending.current?.abort();
	}, []);

	// A sign-in the server is running (this tab's, or another's): re-read the status until it is over,
	// so the row always leaves "Signing in…" by itself. Only while this tab has nothing in flight.
	const serverSigningIn = status?.signingIn === true;
	useEffect(() => {
		if (!serverSigningIn || busy !== null) return;
		const controller = new AbortController();
		const timer = setInterval(() => {
			call({ signal: controller.signal })
				.then((value) => { if (!controller.signal.aborted && value) setStatus(value); })
				.catch(() => { /* the next tick tries again */ });
		}, antigravityStatusTimings.pollMs);
		return () => { clearInterval(timer); controller.abort(); };
	}, [serverSigningIn, busy]);

	const send = async (kind: "saving" | "checking" | "signingIn", body: unknown) => {
		pending.current?.abort();
		const controller = new AbortController();
		pending.current = controller;
		setBusy(kind);
		setError(null);
		try {
			const value = await call({ method: kind === "saving" ? "PUT" : "POST", body: JSON.stringify(body), signal: controller.signal });
			if (controller.signal.aborted) return;
			if (!value) throw new Error("request failed");
			setStatus(value);
			notifySettingsSaved("keys");
		} catch {
			if (!controller.signal.aborted) setError(kind === "saving" ? "Could not save the Antigravity setting." : kind === "signingIn" ? "Could not start the Antigravity sign-in." : "Could not check Antigravity.");
		} finally {
			if (!controller.signal.aborted) setBusy(null);
		}
	};

	if (!status) return null;
	const signingIn = busy === "signingIn" || status.signingIn === true;
	const notSignedIn = status.problem === ANTIGRAVITY_NOT_SIGNED_IN;
	const signInButton = <Button type="button" size="xs" variant={notSignedIn ? "default" : "ghost"} className="cursor-pointer disabled:cursor-not-allowed" disabled={busy !== null || signingIn || !status.installed} onClick={() => void send("signingIn", { action: "signIn" })} data-testid="antigravity-sign-in">Sign in</Button>;
	return <div className="space-y-2" data-testid="antigravity-status">
		<div className="flex items-center gap-3">
			<span className="font-prose text-(length:--lh-prose-size) text-foreground">Antigravity</span>
			<Toggle label="Antigravity" checked={status.enabled} disabled={busy !== null} onChange={(next) => void send("saving", { enabled: next })} />
		</div>
		{error && <p role="alert" className="text-xs text-error">{error}</p>}
		{status.enabled && <div className="flex flex-wrap items-center gap-3">
			<span role="status" className="text-xs text-muted-foreground">{signingIn ? "Signing in… finish in the browser window Antigravity opened." : busy === "checking" ? "Checking…" : antigravityStatusLabel(status)}</span>
			{notSignedIn && signInButton}
			<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" disabled={busy !== null} onClick={() => void send("checking", { action: "check" })} data-testid="antigravity-check">Check connection</Button>
			{!notSignedIn && signInButton}
		</div>}
		<p className="text-xs leading-relaxed text-muted-foreground">Uses your Google Antigravity account. Google&apos;s terms restrict using consumer plans through third-party apps.</p>
	</div>;
}
