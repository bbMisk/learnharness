"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon, MicIcon, SquareIcon } from "lucide-react";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Hint } from "@/components/ui/hint";
import { useTypeWhisperDictation } from "./typewhisper-dictation";
import { deepgramListenUrl, type DictationLanguage } from "@/src/core";
import { useDictationLanguage } from "@/components/dictation-preference";
import { setDictationActive } from "@/components/dictation-state";
export { isDictationActive } from "@/components/dictation-state";

/**
 * Voice dictation. useDictation picks the backend: TypeWhisper on macOS
 * (typewhisper-dictation.ts owns capture and insertion), else the Deepgram
 * cloud engine below.
 *
 * The cloud engine (docs/research/stt.md): the renderer captures mic audio in
 * an AudioWorklet (public/worklets/pcm-capture.js → linear16 16kHz mono),
 * opens the Deepgram streaming WebSocket directly (audio never loops through
 * our server) with a short-lived token from /api/stt/token (the real key
 * stays server-side), and streams frames while it listens.
 *
 *   - Generation counter: every start/stop increments it; async handlers
 *     no-op when stale, so a dying session's socket never tears down the
 *     current one.
 *   - Meter: the level ref keeps the last observed RMS, so a tick with no
 *     fresh audio repeats the last level instead of dropping to silence. dB
 *     window −50..−10 shows conversational speech as mid-height bars.
 *   - Stop: the mic dies first (no more audio enqueues), then CloseStream,
 *     then a 3s safety net in case Deepgram never closes the socket.
 *   - Finals only (interim_results=false, endpointing=300), and deferred:
 *     they buffer during the run and flush into the primary input once, when
 *     the run ends. Only the meter renders while recording.
 *   - One primary input at a time: the pending question's field while one
 *     waits (text mode → the answer, select modes → "Your thinking"), else
 *     the page's composer (useDictationTarget).
 *   - Optimistic start: the meter renders from the click; the token mint and
 *     mic acquisition run concurrently behind it.
 *   - Queue, don't drop: frames arriving before the socket is OPEN buffer
 *     (capped, oldest dropped) and flush in order on open.
 *   - Mic-gated handshake: the WebSocket opens once the capture graph is
 *     live, not after the token. Not token-gated: an OS TCC prompt can
 *     outlive Deepgram's 10s idle timeout.
 *   - Persistent graph: one app-lifetime AudioContext and a memoized worklet
 *     module, so a start doesn't pay context creation and a module fetch.
 *   - Warm token: pre-minted at mount and after every run (TTL 3min); a
 *     stale-token handshake failure heals via the reconnect-once path, which
 *     always mints fresh.
 *   - getUserMedia can't be pre-warmed (the mic indicator would stay lit),
 *     hence the optimistic meter.
 *
 * Meter rendering lives in <DictationBar> (its own 60ms timer over the level
 * ref), so only the bar strip repaints.
 */

/*
 * Deepgram streaming params: nova-3,
 * endpointing=300, no interims. Silence streams too (the worklet never
 * pauses), so the socket never idles — no KeepAlive needed.
 */
// URL construction lives in the browser-safe core; only language varies.

/** Meter tuning, see the file header. */
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;
export const METER_TICK_MS = 60;
/** Rolling history: 48 cells × 60ms ≈ 2.9s of recent loudness. */
export const METER_CELLS = 48;

/** The Deepgram key's id in the keys store (the env-var name — the Keys
 *  section's openRow state and the PUT /api/keys/:id seam). */
export const DEEPGRAM_KEY_ID = "DEEPGRAM_API_KEY";

/** The client-authored keyless line: the token route's raw keyless message is
 * dev-speak, so the surface says this instead. The errored idle button's
 * click recognizes it and deep-links Settings → Keys → the Deepgram row. */
export const DICTATION_KEYLESS = "Dictation needs a Deepgram key";

/** Mint a fresh short-lived token (the route holds the real key). The warm
 *  cache and the reconnect path both bottom out here. The route's keyless
 *  answer (`unavailable`) becomes DICTATION_KEYLESS. Exported for tests. */
export async function mintFreshToken(): Promise<string> {
	const res = await fetch("/api/stt/token");
	const data = (await res.json()) as { token?: string; message?: string; unavailable?: boolean };
	if (!res.ok || !data.token) {
		if (data.unavailable) throw new Error(DICTATION_KEYLESS);
		throw new Error(data.message ?? `token route ${res.status}`);
	}
	return data.token;
}

/** Warm-token cache: the click path takes the cached promise instead of a
 *  remote mint. The TTL keeps it from going stale (a rejected handshake
 *  heals anyway via the reconnect-once path's fresh mint); a failed mint
 *  resets the cache so the next call re-mints.
 *  refresh() re-mints in the background (page mount, run end); its
 *  failures are silently tolerated (a keyless pre-mint just doesn't warm). */
export const WARM_TOKEN_TTL_MS = 3 * 60_000;

export type WarmMinter = { mint: () => Promise<string>; refresh: () => void };

export function createWarmMinter(
	mint: () => Promise<string>,
	now: () => number = Date.now,
	ttlMs: number = WARM_TOKEN_TTL_MS,
): WarmMinter {
	let warm: { p: Promise<string>; at: number } | null = null;
	const m: WarmMinter = {
		mint: () => {
			if (!warm || now() - warm.at > ttlMs) {
				const p = mint().catch((e: unknown) => {
					warm = null; // failed mint: next call re-mints
					throw e;
				});
				warm = { p, at: now() };
			}
			return warm.p;
		},
		refresh: () => {
			warm = null;
			m.mint().catch(() => {}); // background best-effort
		},
	};
	return m;
}

const warmTokens = createWarmMinter(mintFreshToken);

/* Persistent capture graph: one app-lifetime AudioContext + a module-load
 * memo. Created under the click gesture (autoplay policy) and never closed;
 * per-run nodes (source, worklet) disconnect at teardown instead. */
let sharedCtx: AudioContext | null = null;
let workletModule: Promise<void> | null = null;

function ensureAudioGraph(): { ctx: AudioContext; module: Promise<void> } {
	if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: 16000 });
	if (!workletModule) {
		workletModule = sharedCtx.audioWorklet.addModule("/worklets/pcm-capture.js").catch((e: unknown) => {
			workletModule = null; // failed load: retry next run
			throw e;
		});
	}
	return { ctx: sharedCtx, module: workletModule };
}

/** RMS (0..1) → normalized 0..1 across the audible dB window. */
export function rmsToMeter(rms: number): number {
	if (rms <= 0) return 0;
	const db = 20 * Math.log10(rms);
	const t = (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB);
	return Math.max(0, Math.min(1, t));
}

/**
 * The primary-input registry: at most ONE non-composer input can claim the
 * dictation target while mounted — the pending question's answer/thinking
 * field (question-dock.tsx). The page's `append` (the composer) is the
 * fallback when nobody claims. Module-level by design: the claimant is a
 * sibling subtree far from the hook's owner, and there is exactly one
 * window, one pending question, one target at a time.
 */
let questionTarget: ((text: string) => void) | null = null;

/* The finisher registry: submit paths FAR from the hook's owner (the
 * pending question's dock) need finish() without a prop bridge. Same
 * module-level pattern as questionTarget — one window, one instance,
 * one finisher. Empty registry (no hook mounted) → resolve immediately. */
let dictationFinisher: (() => Promise<void>) | null = null;

/** Finish any live dictation run before continuing (see Dictation.finish). */
export function finishDictation(): Promise<void> {
	return dictationFinisher ? dictationFinisher() : Promise.resolve();
}

/** Join a dictated final onto the current text (shared separator rule). */
export function joinDictation(current: string, final: string): string {
	return current ? current.replace(/\s+$/, "") + " " + final : final;
}

/**
 * Claim the dictation target while mounted (and `claimed` is true). The
 * unmount guard is identity-based so dev-mode double-invoked effects
 * can't clear another claimant.
 */
export function useDictationTarget(append: (text: string) => void, claimed: boolean) {
	useEffect(() => {
		if (!claimed) return;
		questionTarget = append;
		return () => {
			if (questionTarget === append) questionTarget = null;
		};
	}, [append, claimed]);
}

export type DictationPhase = "idle" | "connecting" | "recording" | "stopping";

export type Dictation = {
	backend?: "typewhisper";
	phase: DictationPhase;
	/** Terminal-state explanation, shown inside the wide button (cleared on the next start). */
	error: string | null;
	/** Latest observed RMS, 0..1 — sampled by the meter's own tick, never reset. */
	levelRef: { current: number };
	/** Not idle — from the click until the stop completes (the optimistic window). */
	active: boolean;
	/** End + KEEP the transcript: flush the deferred buffer into the primary
	 *  input (the Stop pill and ⌘D). */
	toggle: () => void;
	stop: () => void;
	/** Finish, then continue: if a run is live, stop it and resolve only when
	 *  it has fully ended (the last finals are in the target field). Submit
	 *  paths await this before building their payload, so forgetting to stop
	 *  dictation before Enter never loses the spoken text. Idle resolves
	 *  immediately. Every terminal path runs cleanup(), which resolves the
	 *  waiters; cancel (Esc) resolves them too. */
	finish: () => Promise<void>;
	/** Esc. Browser: end + DISCARD the transcript (a cancel, not a stop).
	 *  TypeWhisper: stop + KEEP, using its supported start/stop controls. */
	cancel: () => void;
	/** Clear the terminal error without starting a run: the keyless click
	 * leaves for Settings and the surface must come back clean. */
	clearError: () => void;
};

/**
 * One dictation instance per composer-bearing page. `append` is the
 * composer fallback; the mounted question form's claim wins while a
 * question waits.
 */
export function useDictation({ append }: { append: (text: string) => void }): Dictation {
	const [backend, setBackend] = useState<"loading" | "typewhisper" | "deepgram">("loading");
	useEffect(() => { setBackend(window.lh?.platform === "darwin" ? "typewhisper" : "deepgram"); }, []);
	const native = backend === "typewhisper";
	const cloud = useDeepgramDictation({ append, enabled: backend === "deepgram" });
	const local = useTypeWhisperDictation(native);
	const dictation = native ? local : cloud;
	useEffect(() => {
		setDictationActive(dictation.active);
		dictationFinisher = dictation.finish;
		return () => { if (dictationFinisher === dictation.finish) { dictationFinisher = null; setDictationActive(false); } };
	}, [dictation.active, dictation.finish]);
	useEffect(() => {
		window.addEventListener("lh:kbd-toggle-dictation", dictation.toggle);
		window.addEventListener("lh:kbd-cancel-dictation", dictation.cancel);
		return () => {
			window.removeEventListener("lh:kbd-toggle-dictation", dictation.toggle);
			window.removeEventListener("lh:kbd-cancel-dictation", dictation.cancel);
		};
	}, [dictation.toggle, dictation.cancel]);
	return dictation;
}

function useDeepgramDictation({ append, enabled }: { append: (text: string) => void; enabled: boolean }): Dictation {
	const { getLanguage } = useDictationLanguage();
	const [phase, setPhase] = useState<DictationPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	/** Latest RMS from the worklet; the meter samples this. */
	const levelRef = useRef(0);
	/** The page's fallback append — kept fresh per render so a mid-recording
	 *  retarget (composer↔question) is honored on the very next final. */
	const appendRef = useRef(append);
	appendRef.current = append;

	// Live machinery (non-render values). The MediaStream tracks stop and
	// the per-run nodes disconnect on teardown; the socket is recreated per
	// run; the AudioContext is app-lifetime.
	const wsRef = useRef<WebSocket | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	/** Per-run graph nodes; the context outlives runs. */
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const workletRef = useRef<AudioWorkletNode | null>(null);
	/** Frames captured before the socket is OPEN: flushed in
	 *  order on open; capped at 256 frames (≈32s) with the oldest dropped;
	 *  cleared at teardown so a dead run's audio can't leak into the next. */
	const pendingRef = useRef<ArrayBuffer[]>([]);
	const genRef = useRef(0); // stale-handler guard
	const safetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconnectsRef = useRef(0);
	/** The deferred transcript: finals land here during the run and flush
	 *  into the primary input once, at teardown. */
	const bufferRef = useRef<string[]>([]);
	/** Resolvers waiting for the run to fully end (finish()): released by
	 *  cleanup(), which every terminal path runs. */
	const waitersRef = useRef<Array<() => void>>([]);

	/** Flush the buffered transcript into the primary input — question claim
	 *  first, composer fallback. Called exactly once per run, at cleanup; the
	 *  buffer clears itself so double-cleanup is a no-op. */
	const flush = useCallback(() => {
		if (bufferRef.current.length === 0) return;
		const text = bufferRef.current.join(" ");
		bufferRef.current = [];
		(questionTarget ?? appendRef.current)(text);
	}, []);

	/** Full teardown of one run's machinery. Idempotent; generation-guarded by callers. */
	const cleanup = useCallback((warmNext = true) => {
		genRef.current++;
		setDictationActive(false);
		flush(); // the deferred transcript appears when the run ends
		if (safetyRef.current) {
			clearTimeout(safetyRef.current);
			safetyRef.current = null;
		}
		pendingRef.current = [];
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect();
		sourceRef.current = null;
		workletRef.current?.disconnect();
		workletRef.current = null;
		// The AudioContext is app-lifetime: nodes die, it stays.
		const ws = wsRef.current;
		wsRef.current = null;
		if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
			try {
				ws.close();
			} catch {}
		}
		setPhase("idle");
		// The finish() waiters ride until NOW — post-flush, post-teardown:
		// a submit path resuming after `await finishDictation()` reads the
		// target field with the dictated tail already in it.
		for (const w of waitersRef.current.splice(0)) w();
		// Pre-mint for the next run (best-effort; a keyless page just doesn't
		// warm).
		if (warmNext) warmTokens.refresh();
	}, []);

	/** Open the Deepgram socket and wire its messages. `gen` guards staleness. */
	const openSocket = useCallback(
		(gen: number, token: string, language: DictationLanguage) => {
			// Minted JWTs authenticate via the "bearer" subprotocol — ["token",
			// jwt] is rejected at the handshake ("token" is for raw API keys).
			const ws = new WebSocket(deepgramListenUrl(language), ["bearer", token]);
			wsRef.current = ws;

			ws.addEventListener("open", () => {
				if (gen !== genRef.current) return;
				// Everything captured during the handshake (or a reconnect gap)
				// goes out now, in order; Deepgram accepts faster-than-realtime
				// sends.
				for (const frame of pendingRef.current) ws.send(frame);
				pendingRef.current = [];
				setPhase("recording");
			});
			ws.addEventListener("message", (ev) => {
				if (gen !== genRef.current) return;
				let msg: any;
				try {
					msg = JSON.parse(ev.data as string);
				} catch {
					return;
				}
				if (msg.type === "Results") {
					const text: string | undefined = msg.channel?.alternatives?.[0]?.transcript;
					// Only finals stream (interim_results=false). They buffer here
					// and reach the input once, at teardown.
					if (msg.is_final && text) bufferRef.current.push(text);
				}
			});
			ws.addEventListener("close", (ev) => {
				if (gen !== genRef.current) return;
				if (ev.code === 1000) {
					// Our own CloseStream landing: finalize now — the stop path's
					// safety net stays as the no-close backstop only.
					cleanup();
					return;
				}
				// Abnormal close mid-run: one reconnect with a fresh token.
				if (reconnectsRef.current < 1) {
					reconnectsRef.current++;
					mintFreshToken() // always FRESH — a stale warm token is the likely culprit
						.then((t) => {
							if (gen === genRef.current) openSocket(gen, t, language);
						})
						.catch(() => {
							if (gen === genRef.current) {
								setError("Deepgram reconnect failed");
								cleanup();
							}
						});
				} else {
					setError(`Deepgram connection lost (${ev.code})`);
					cleanup();
				}
			});
		},
		[cleanup],
	);

	const start = useCallback(async () => {
		setDictationActive(true);
		setError(null);
		setPhase("connecting");
		reconnectsRef.current = 0;
		bufferRef.current = []; // fresh run, fresh buffer
		pendingRef.current = []; // fresh run, fresh queue
		const gen = ++genRef.current;
		let language: DictationLanguage;
		try {
			language = await getLanguage();
		} catch (e) {
			if (gen !== genRef.current) return;
			setError(e instanceof Error ? e.message : "Dictation language unavailable");
			cleanup();
			return;
		}
		if (gen !== genRef.current) return;

		// The warm token (pre-minted at mount / after the last run) resolves
		// ~instantly; a cold/keyless mint surfaces below. The
		// mic is the long pole (macOS HAL + APM init) and gates everything —
		// the token runs concurrently with it. 127.0.0.1 is a secure
		// context, so getUserMedia works without TLS; macOS TCC prompts on
		// first use.
		const tokenPromise = warmTokens.mint();
		tokenPromise.catch(() => {}); // surfaced below; no unhandled rejection
		const micPromise = navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
		let stream: MediaStream;
		try {
			stream = await micPromise;
			if (gen !== genRef.current) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			streamRef.current = stream;

			// App-lifetime context + memoized worklet module: no per-run
			// context creation or module fetch.
			const { ctx, module } = ensureAudioGraph();
			await module;
			if (ctx.state === "suspended") await ctx.resume();
			if (gen !== genRef.current) return;

			const worklet = new AudioWorkletNode(ctx, "pcm-capture");
			workletRef.current = worklet;
			worklet.port.onmessage = (e) => {
				const msg = e.data as { type: string; rms?: number; buffer?: ArrayBuffer };
				if (msg.type === "level") {
					levelRef.current = msg.rms ?? 0; // never reset to zero (dictate pattern)
				} else if (msg.type === "audio") {
					const ws = wsRef.current;
					if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg.buffer!);
					// Not OPEN yet (handshake or reconnect gap): queue, capped;
					// the open handler flushes in order.
					else {
						pendingRef.current.push(msg.buffer!);
						if (pendingRef.current.length > 256) pendingRef.current.shift();
					}
				}
			};
			const source = ctx.createMediaStreamSource(stream);
			sourceRef.current = source;
			source.connect(worklet);
			// Pull the graph with silence out (the worklet writes no output) —
			// an unconnected worklet node is never clocked.
			worklet.connect(ctx.destination);
		} catch (e) {
			if (gen !== genRef.current) return;
			const msg =
				e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")
					? "Microphone permission denied"
					: e instanceof Error
						? e.message
						: "mic unavailable";
			setError(msg);
			cleanup();
			return;
		}
		if (gen !== genRef.current) return;
		let token: string;
		try {
			token = await tokenPromise;
		} catch (e) {
			if (gen !== genRef.current) return;
			setError(e instanceof Error ? e.message : "token unavailable");
			cleanup();
			return;
		}
		if (gen !== genRef.current) return;
		// The handshake fires the moment the graph is live (mic-gated, never
		// before it).
		openSocket(gen, token, language);
	}, [openSocket, cleanup, getLanguage]);

	const stop = useCallback(() => {
		const gen = genRef.current;
		if (phase !== "recording" && phase !== "connecting") return;
		setPhase("stopping");

		// Mic dies first, so no more audio enqueues. The per-run nodes die with
		// it; the AudioContext stays.
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect();
		sourceRef.current = null;
		workletRef.current?.disconnect();
		workletRef.current = null;

		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify({ type: "CloseStream" }));
			} catch {
				cleanup();
				return;
			}
			// Deepgram flushes remaining finals then closes; if it never
			// does, the safety net ends the run anyway (dictate pattern).
			safetyRef.current = setTimeout(() => {
				if (gen === genRef.current) cleanup();
			}, 3000);
		} else {
			cleanup();
		}
	}, [phase, cleanup]);

	const cancel = useCallback(() => {
		if (phase === "idle") return;
		// Discard first, teardown second — cleanup() flushes, and the now-empty
		// buffer makes that flush a no-op. Also kills a "stopping" run: the
		// flush already underway is abandoned (its timer is cleared inside).
		bufferRef.current = [];
		cleanup();
	}, [phase, cleanup]);

	const finish = useCallback((): Promise<void> => {
		return new Promise((resolve) => {
			if (phase === "idle") {
				resolve();
				return;
			}
			waitersRef.current.push(resolve);
			// "stopping" is already ending — the waiter just rides to cleanup.
			if (phase === "recording" || phase === "connecting") stop();
		});
	}, [phase, stop]);

	const toggle = useCallback(() => {
		if (!enabled) return;
		if (phase === "idle") void start();
		else if (phase === "recording" || phase === "connecting") stop();
		// "stopping" presses are ignored — the flush is in flight.
	}, [phase, start, stop, enabled]);

	// Warm a token while enabled; unmount discards the buffer and tears down.
	useEffect(() => {
		if (enabled) warmTokens.refresh();
		return () => { bufferRef.current = []; cleanup(false); };
	}, [enabled, cleanup]);

	return {
		phase,
		error,
		levelRef,
		active: phase !== "idle",
		toggle,
		stop,
		finish,
		cancel,
		clearError: () => setError(null),
	};
}

/**
 * The stats-bar dictation slot: the row's middle is one strip that is always
 * the full free width —
 *
 *   idle      a wide, quiet "Dictate" button (mic + label, grayed out; the
 *             whole middle is the affordance).
 *   active    optimistic from the CLICK: red stop pill + the fixed-width
 *             meter (no interim text ever shifts it). Spinner while
 *             Deepgram flushes the last final.
 *   error     the wide button again, label swapped for the failure reason
 *             (full text in the tooltip), cleared on the next click.
 */
export function DictationBar({ dictation }: { dictation: Dictation }) {
	const { phase, error, levelRef, toggle, active, clearError } = dictation;
	const typeWhisper = dictation.backend === "typewhisper";
	const { open: openSettings } = useSettingsDialog();
	/** The keyless click: the errored idle button deep-links Settings → Keys →
	 *  the Deepgram row and clears the error. Any other error's click is a
	 *  retry (which also clears). */
	const keyless = error === DICTATION_KEYLESS;
	const [levels, setLevels] = useState<number[]>(() => new Array(METER_CELLS).fill(0));
	/** Adaptive cell count from the meter's measured width: narrow rows show
	 *  fewer bars instead of overflowing under neighbors. */
	const [cellCount, setCellCount] = useState(METER_CELLS);
	const meterRef = useRef<HTMLDivElement | null>(null);

	// The meter's own heartbeat — 60ms samples of the level ref into a
	// rolling ring. Only THIS strip re-renders; the page never does.
	useEffect(() => {
		if (!active || typeWhisper) return;
		setLevels(new Array(METER_CELLS).fill(0));
		const id = setInterval(() => {
			setLevels((ring) => {
				const next = ring.slice(1);
				next.push(rmsToMeter(levelRef.current));
				return next;
			});
		}, METER_TICK_MS);
		return () => clearInterval(id);
	}, [active, levelRef, typeWhisper]);

	// Fit the cell count to the available width (4px pitch per cell:
	// 2px bar + 2px gap, clamped 8..48). The meter div's width is set by
	// the row's free space — cells carry no minimum width — so measuring
	// it once per activation + on resize keeps the strip honest in the
	// draft/home rows where the slider leaves little middle.
	useEffect(() => {
		if (!active || typeWhisper) return;
		const el = meterRef.current;
		if (!el) return;
		const fit = () => {
			const w = el.clientWidth;
			setCellCount(Math.max(8, Math.min(METER_CELLS, Math.floor(w / 4))));
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	}, [active, typeWhisper]);

	if (!active) {
		return (
			<Hint
				// Errored: the button span truncates the line and the tooltip shows
				// it in full (the keyless line keeps "Deepgram": it's the Keys row
				// label). Otherwise the quiet label + the live ⌘D binding.
				label={error ?? (typeWhisper ? "Dictate with TypeWhisper" : "Dictate")}
				action={error ? undefined : "toggle-dictation"}
				side="top"
			>
				<button
					type="button"
					onMouseDown={(e) => { if (typeWhisper) e.preventDefault(); }}
					onClick={() => {
						if (keyless) {
							clearError();
							openSettings("keys", DEEPGRAM_KEY_ID);
						} else {
							toggle();
						}
					}}
					aria-label={error ? `Dictation failed: ${error}` : "Start dictation"}
					data-testid="dictation-toggle"
					className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border/50 bg-card/50 text-xs text-muted-foreground/70 shadow-lg backdrop-blur transition-colors hover:border-border hover:text-muted-foreground"
				>
					<MicIcon className="size-3.5" />
					<span className="max-w-full truncate">{error ?? (typeWhisper ? "TypeWhisper" : "Dictate")}</span>
				</button>
			</Hint>
		);
	}

	if (typeWhisper) {
		const finishing = phase === "stopping";
		return <div className="flex w-full min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1" data-testid="dictation-bar">
			<button type="button" data-testid="dictation-toggle" aria-label="End transcription" aria-busy={finishing} disabled={finishing}
				onMouseDown={event => event.preventDefault()} onClick={dictation.stop}
				className="flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-card/85 px-2.5 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-wait disabled:text-muted-foreground">
				{finishing ? <Loader2Icon className="size-3.5 animate-spin"/> : <SquareIcon className="size-3 fill-current"/>}
				{finishing ? "Transcribing…" : "End transcription"}
			</button>
			<span role="status" aria-live="polite" className="flex items-center gap-1.5 text-xs text-muted-foreground">
				{!finishing && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden/>}
				{finishing ? <span className="sr-only">Finishing transcription. Your text will be kept.</span> : phase === "connecting" ? "Starting…" : "Recording"}
			</span>
		</div>;
	}

	return (
		<div className="flex w-full min-w-0 items-center gap-2" data-testid="dictation-bar">
			<Hint label="Stop dictation (Esc)" side="top">
				<button
					type="button"
					onMouseDown={(e) => { if (typeWhisper) e.preventDefault(); }}
					onClick={toggle}
					disabled={phase === "stopping"}
					aria-label="Stop dictation"
					data-testid="dictation-toggle"
					className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-destructive/10 px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
				>
					{phase === "stopping" ? <Loader2Icon className="size-3.5 animate-spin" /> : <MicIcon className="size-3.5" />}
					Stop
				</button>
			</Hint>
			<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
			{/* Fixed width while recording (no interim text beside it). Cells
			    carry no minimum width; the count adapts to the measured row
			    space. */}
			{typeWhisper ? <span className="truncate text-xs text-muted-foreground">{phase === "stopping" ? "TypeWhisper processing…" : phase === "connecting" ? "Starting TypeWhisper…" : "TypeWhisper recording"}</span> : <div ref={meterRef} className="flex h-4 min-w-0 flex-1 items-center gap-[2px]" data-testid="dictation-meter">
				{levels.slice(-cellCount).map((v, i) => (
					<span
						key={i}
						className="min-w-0 flex-1 rounded-full bg-foreground/40"
						style={{ height: `${2 + Math.round(v * 14)}px` }}
					/>
				))}
			</div>}
		</div>
	);
}
