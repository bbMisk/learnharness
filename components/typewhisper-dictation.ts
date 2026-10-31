"use client";

import { useEffect, useRef, useState } from "react";
import type { Dictation, DictationPhase } from "./dictation";

type Session = { id: string; status: string; message?: string };
type Request = (action: "start" | "stop" | "session", id?: string) => Promise<Session>;

/** One owned recording, one stop, and one completion wait even when Enter,
 * Esc, and the button race. TypeWhisper owns microphone capture and insertion. */
export class TypeWhisperDictationController {
	phase: DictationPhase = "idle";
	private run: Promise<void> = Promise.resolve();
	private stopRequested = false;
	private disposed = false;
	constructor(
		private request: Request,
		private changed: (phase: DictationPhase, error: string | null) => void,
		private pollMs = 300,
	) {}
	private publish(phase: DictationPhase, error: string | null = null) {
		this.phase = phase;
		if (!this.disposed) this.changed(phase, error);
	}
	start() {
		if (this.phase !== "idle") return;
		this.stopRequested = false;
		this.publish("connecting");
		this.run = (async () => {
			let sessionId: string | undefined;
			let stopped = false;
			try {
				const { id } = await this.request("start");
				sessionId = id;
				let processingSince = 0;
				for (;;) {
					if (this.stopRequested && !stopped) {
						await this.request("stop", id);
						stopped = true;
					}
					const session = await this.request("session", id);
					if (session.status === "completed") break;
					if (session.status === "failed")
						throw new Error(
							session.message ?? "TypeWhisper could not finish dictation. Check its indicator or Recovery settings.",
						);
					const processing = this.stopRequested || session.status === "processing";
					this.publish(processing ? "stopping" : "recording");
					if (processing) {
						processingSince ||= Date.now();
						if (Date.now() - processingSince > 120_000)
							throw new Error("TypeWhisper is still processing. Check its menu bar indicator.");
					}
					await new Promise((resolve) => setTimeout(resolve, this.pollMs));
				}
				this.publish("idle");
			} catch (error) {
				if (sessionId && !stopped) await this.request("stop", sessionId).catch(() => undefined);
				this.publish("idle", error instanceof Error ? error.message : "Cannot reach TypeWhisper. Use F3 to control it directly.");
			}
		})();
	}
	finish() {
		if (this.phase !== "idle") {
			this.stopRequested = true;
			this.publish("stopping");
		}
		return this.run;
	}
	dispose() {
		this.disposed = true;
		void this.finish();
	}
}

async function request(action: "start" | "stop" | "session", id?: string): Promise<Session> {
	const url = "/api/stt/typewhisper";
	const response =
		action === "session"
			? await fetch(`${url}?id=${encodeURIComponent(id!)}`, { cache: "no-store" })
			: await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id }) });
	const result = await response.json();
	if (!response.ok) throw new Error(result.message ?? "TypeWhisper request failed.");
	return result;
}

/** TypeWhisper types into the focused field: a textarea, a text input, or a
 *  lesson rich-text box (the composer and docks are contenteditable). */
const DICTATION_FIELD = 'textarea, input[type="text"], [role="textbox"][contenteditable="true"]';

function usableField(el: HTMLElement): boolean {
	return !(el as HTMLTextAreaElement).disabled && el.getAttribute("aria-disabled") !== "true" && el.getClientRects().length > 0;
}

function focusDictationField(): HTMLElement {
	const focused = document.activeElement;
	if (focused instanceof HTMLElement && focused.matches(DICTATION_FIELD)) return focused;
	for (const scope of [
		'[data-testid="reading-thinking-field"]',
		'[data-testid="question-dock"]',
		'[data-testid="practice-dock"]',
		'[data-testid="composer"]',
		"",
	]) {
		const selector = scope
			? DICTATION_FIELD.split(", ")
					.map((field) => `${scope} ${field}`)
					.join(", ")
			: DICTATION_FIELD;
		const field = [...document.querySelectorAll<HTMLElement>(selector)].find(usableField);
		if (field) {
			field.focus();
			return field;
		}
	}
	throw new Error("Focus a lesson text field before dictating.");
}

export function useTypeWhisperDictation(enabled: boolean): Dictation {
	const [phase, setPhase] = useState<DictationPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	const levelRef = useRef(0);
	const controller = useRef<TypeWhisperDictationController | null>(null);
	const target = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (!enabled) return;
		const current = new TypeWhisperDictationController(request, (next, message) => {
			setPhase(next);
			setError(message);
		});
		controller.current = current;
		return () => {
			current.dispose();
			if (controller.current === current) controller.current = null;
		};
	}, [enabled]);
	const finish = () => {
		// Restore the recording's field before TypeWhisper inserts its final text.
		// A removed field must never prevent the microphone from stopping.
		if (controller.current?.phase !== "idle" && target.current?.isConnected && usableField(target.current)) target.current.focus();
		return controller.current?.finish() ?? Promise.resolve();
	};
	const toggle = () => {
		if (controller.current && controller.current.phase !== "idle") {
			void finish();
			return;
		}
		try {
			target.current = focusDictationField();
			controller.current?.start();
		} catch (error) {
			setError(error instanceof Error ? error.message : "Focus a text field first.");
		}
	};
	return {
		phase,
		error,
		levelRef,
		active: phase !== "idle",
		backend: "typewhisper",
		toggle,
		stop: () => void finish(),
		finish,
		cancel: () => void finish(),
		clearError: () => setError(null),
	};
}
