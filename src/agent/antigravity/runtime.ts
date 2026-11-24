/**
 * The one shared `agy acp` process per server process: lazy start, the ACP
 * handshake, per-session routing, idle and shutdown kills, and temp-folder
 * cleanup. Nothing here starts the binary except AntigravityRuntime.connect,
 * which only a turn or an explicit "Check connection" calls.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import packageMetadata from "../../../package.json" with { type: "json" };
import { externalCliEnv } from "../../core/auth-env.ts";
import { AcpPeer, AcpTransportError, type Stamped, isAcpRpcError, isAcpTransportError, isRecord, methodNotFound, SIGN_IN_LINE_PREFIX, stripUrls } from "./acp-client.ts";
import { createAgentLauncher, type LaunchAgent } from "./binary.ts";
import { AntigravityMessage } from "./constants.ts";

/** Test seams (claude-code/live-processes.ts's liveProcessIdleTimeoutMs idiom). */
export const antigravityTimeouts = {
	/** initialize, and every setup request of a turn (session/new, set_config_option, …). */
	startupMs: 90_000,
	/** No turn in flight for this long: the process is stopped. Long enough that a learner thinking for a
	 *  while doesn't pay the cold start again; turning the provider off stops it at once. */
	idleMs: 30 * 60_000,
	/** An open prompt with no update for this long is cancelled. */
	inactivityMs: 15 * 60_000,
	/** After session/cancel, how long the prompt may take to resolve before the process is killed. */
	cancelGraceMs: 5_000,
	/** SIGTERM, then SIGKILL after this. */
	killGraceMs: 1_000,
	/** After `exit`, how long buffered output may still be read if `close` doesn't come first. */
	exitDrainMs: 250,
	/** A held tool call waits this long for its result (the agent itself gives up at 3 minutes). */
	toolWaitMs: 150_000,
	/** For a helper run (jobs, extraction, plugins) no learner is waited for: a helper that ends right after a
	 *  tool call (extraction's submit) must not hold its agent prompt open for the whole 150 s. */
	helperToolWaitMs: 60_000,
	/** The user's Sign in click: how long the agent's browser sign-in may take. */
	signInMs: 5 * 60_000,
};

const STDERR_PARTIAL_BYTES = 4_096;
/** The only auth method LearnHarness asks for: a personal Google sign-in the agent runs itself. */
const GOOGLE_SIGN_IN_METHOD = "oauth-personal";
/** Sessions nobody watches yet whose early state is remembered. */
const EARLY_MAX_SESSIONS = 20;
const TEMP_FOLDER = "learnharness-antigravity";
const RUN_PREFIX = "run-";
const STRIPPED_KEYS = new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);

export class AgentUnavailable extends Error {
	readonly brand = "agent-unavailable" as const;
}

function isAgentUnavailable(error: unknown): error is AgentUnavailable {
	const e = error as Partial<AgentUnavailable> | null;
	return !!e && typeof e === "object" && e.brand === "agent-unavailable" && typeof e.message === "string";
}

/**
 * How an agent error is classified, in one place for the turn, the check and describeAgentError.
 * Not signed in: -32000, or the 1.5 agent's "No browser is available here" -32603, on any request.
 */
export function isSignInError(error: unknown): boolean {
	return isAcpRpcError(error) && (error.code === -32000 || (error.code === -32603 && error.message.startsWith("No browser is available here")));
}

/** The Google account can't use Antigravity. */
export function isSubscriptionError(error: unknown): boolean {
	return isAcpRpcError(error) && error.message.includes("SUBSCRIPTION_REQUIRED");
}

/** The agent refused a value (a mode, model or level), not the account: the caller decides what that costs. */
export function isValueRefusal(error: unknown): boolean {
	return isAcpRpcError(error) && !isSignInError(error) && !isSubscriptionError(error);
}

export interface AgentHandshake {
	/** "1.5.12", from agentInfo.version. */
	agentVersion: string | null;
	/** initialize advertised agentCapabilities._meta.antigravity.systemPrompt.append. */
	systemPromptAppend: boolean;
	/** initialize advertised sessionCapabilities.close. */
	sessionClose: boolean;
	/** initialize advertised promptCapabilities.image. */
	promptImages: boolean;
	/** initialize listed the "oauth-personal" auth method (the only one LearnHarness ever asks for). */
	googleSignIn: boolean;
}

export interface SessionListener {
	/** `frame`: the number of the incoming frame the update arrived in (kept when an early update is replayed). */
	onUpdate(update: Record<string, unknown>, frame: number): void;
	/** The answer to session/request_permission for this session. */
	onPermissionRequest(params: Record<string, unknown>): unknown;
	/** The process is gone; `error.message` is one of ours. */
	onClosed(error: AcpTransportError): void;
}

/**
 * What is remembered for a session before anyone watches it: no message or
 * thought text, only whether a breach happened (sticky), the latest config
 * options and the latest mode.
 */
type Early = {
	breach?: { kind: "tool" | "permission"; title?: string; toolKind?: string };
	/** Each with the frame it arrived in, so the replay keeps their order. */
	configOptions?: { value: unknown[]; frame: number };
	modeId?: { value: string; frame: number };
	/** The first mode or config update that couldn't be read: replayed, so the turn can't confirm the mode. */
	malformed?: { update: Record<string, unknown>; frame: number };
};

function label(value: unknown): string | undefined {
	return typeof value === "string" ? value.slice(0, 200) : undefined;
}

const CANCELLED = { outcome: { outcome: "cancelled" } };

/** The answer LearnHarness gives every permission request: the reject_once option, else cancelled. */
export function rejectOnce(params: Record<string, unknown>): unknown {
	const options = Array.isArray(params.options) ? params.options : [];
	const reject = options.find((option) => isRecord(option) && option.kind === "reject_once" && typeof option.optionId === "string") as { optionId: string } | undefined;
	return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : CANCELLED;
}

/** Accepts the v1 result shapes with protocolVersion 1 or 2 (the 1.5 agent reports 2). */
export function parseHandshake(result: unknown): AgentHandshake | null {
	if (!isRecord(result) || (result.protocolVersion !== 1 && result.protocolVersion !== 2)) return null;
	const capabilities = isRecord(result.agentCapabilities) ? result.agentCapabilities : undefined;
	const info = isRecord(result.agentInfo) ? result.agentInfo : undefined;
	if (!capabilities && !info) return null;
	const version = typeof info?.version === "string" ? /^(?:agy_acp_server_)?(\d+\.\d+\.\d+)/.exec(info.version)?.[1] ?? null : null;
	const meta = isRecord(capabilities?._meta) && isRecord(capabilities._meta.antigravity) && isRecord(capabilities._meta.antigravity.systemPrompt)
		? capabilities._meta.antigravity.systemPrompt : undefined;
	const sessionCapabilities = isRecord(capabilities?.sessionCapabilities) ? capabilities.sessionCapabilities : undefined;
	const close = sessionCapabilities?.close;
	const prompts = isRecord(capabilities?.promptCapabilities) ? capabilities.promptCapabilities : undefined;
	const authMethods = Array.isArray(result.authMethods) ? result.authMethods : [];
	const googleSignIn = authMethods.some((method) => isRecord(method) && method.id === GOOGLE_SIGN_IN_METHOD);
	return { agentVersion: version, systemPromptAppend: meta?.append === true, sessionClose: close === true || isRecord(close), promptImages: prompts?.image === true, googleSignIn };
}

/** One plain sentence for any failure; never raw agent output, never a link. */
export function describeAgentError(error: unknown): string {
	if (isAcpRpcError(error)) {
		if (isSignInError(error)) return AntigravityMessage.NotSignedIn;
		if (isSubscriptionError(error)) return AntigravityMessage.NoSubscription;
		// The agent's own words stay on the server.
		const detail = stripUrls(error.message).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().slice(0, 300);
		console.error(`Antigravity reported an error (code ${error.code})${detail ? `: ${detail}` : "."}`);
		return `Antigravity reported an error (code ${error.code}).`;
	}
	if (isAcpTransportError(error) || isAgentUnavailable(error)) return error.message;
	return "Antigravity could not be reached.";
}

/** externalCliEnv(), minus any Gemini/Google API key (whatever its case), plus a private temp folder. */
export function agentEnv(base: Record<string, string | undefined>, tempDir: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
	const env = { ...base };
	for (const key of Object.keys(env)) if (STRIPPED_KEYS.has(key.toUpperCase())) delete env[key];
	if (platform === "win32") { env.TEMP = tempDir; env.TMP = tempDir; }
	else env.TMPDIR = tempDir;
	return env as NodeJS.ProcessEnv;
}

function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } // signal 0 only checks existence
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Remove temp roots left by server processes that have exited. Live owners' roots stay. */
export function sweepLeftovers(base: string): void {
	let names: string[];
	try { names = readdirSync(base); } catch { return; }
	for (const name of names) {
		const pid = Number(/^run-(\d+)-/.exec(name)?.[1]);
		if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || pidAlive(pid)) continue;
		try { rmSync(join(base, name), { recursive: true, force: true }); } catch { /* next start retries */ }
	}
}

// Live connections, for the one process-exit hook (src/server/web-subscriptions.ts's precedent).
type ExitState = { live: Set<AgentConnection>; hooked: boolean };
const EXIT_KEY = Symbol.for("lh.antigravity.exit");
function exitState(): ExitState {
	const g = globalThis as Record<symbol, ExitState | undefined>;
	g[EXIT_KEY] ??= { live: new Set(), hooked: false };
	const state = g[EXIT_KEY];
	if (!state.hooked) {
		state.hooked = true;
		process.once("exit", () => { for (const connection of exitState().live) connection.killNow(); });
	}
	return state;
}

export class AgentConnection {
	handshake: AgentHandshake = { agentVersion: null, systemPromptAppend: false, sessionClose: false, promptImages: false, googleSignIn: false };
	readonly workspace: string;
	readonly closed: Promise<AcpTransportError>;
	private readonly peer: AcpPeer;
	private readonly listeners = new Map<string, SessionListener>();
	private readonly early = new Map<string, Early>();
	private listenerFailureLogged = false;
	private holders = 0;
	private stopWhenIdle = false;
	private idleTimer: NodeJS.Timeout | undefined;
	private killTimer: NodeJS.Timeout | undefined;
	private fatalError: AcpTransportError | undefined;
	private stderrBytes = 0;
	private stderrPartial = "";
	private exited = false;
	/** The process has exited; buffered output may still be read until `close` or the drain delay. */
	private gone = false;
	private exitInfo: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
	private drainTimer: NodeJS.Timeout | undefined;
	private stopping = false;
	private resolveClosed!: (error: AcpTransportError) => void;

	constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly root: string) {
		this.workspace = join(root, "workspace");
		this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
		this.peer = new AcpPeer(child.stdin, {
			onNotification: (method, params) => this.route(method, params),
			onRequest: (method, params) => this.serve(method, params),
			onFatal: (error) => this.fail(error),
		});
		child.stdout.on("data", (chunk: Buffer) => this.peer.receive(chunk));
		child.stderr.on("data", (chunk: Buffer) => this.readStderr(chunk));
		for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => { /* the exit handler reports the failure */ });
		// A spawn failure may emit only `error`; a running child that fails to be signalled emits it too,
		// possibly more than once: `on`, and both branches are idempotent.
		child.on("error", () => {
			if (child.pid === undefined) this.handleExit();
			else this.fail(new AcpTransportError("closed", AntigravityMessage.Exited));
		});
		// `exit` ends the process, but its last output (a final answer, the sign-in line) may still be
		// in the pipe: finish on `close`, or after a short drain since a helper that inherited the
		// pipes can hold `close` back forever.
		child.once("exit", (code, signal) => {
			this.gone = true;
			this.exitInfo = { code, signal };
			clearTimeout(this.killTimer);
			this.drainTimer = setTimeout(() => this.handleExit(), antigravityTimeouts.exitDrainMs);
			this.drainTimer.unref();
		});
		child.once("close", (code, signal) => {
			if (!this.gone) this.exitInfo = { code, signal };
			this.handleExit();
		});
		exitState().live.add(this);
	}

	get alive(): boolean { return !this.exited && !this.gone && !this.stopping; }

	/** Why the connection failed, if it did (sign-in, protocol, timeout). */
	get failure(): AcpTransportError | undefined { return this.fatalError; }

	/** A turn is watching this session. */
	watching(sessionId: string): boolean {
		return this.listeners.has(sessionId);
	}

	/** The shared handshake; kills the process on any failure. */
	async initialize(appVersion: string): Promise<void> {
		let result: unknown;
		try {
			result = await this.peer.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				clientInfo: { name: "learnharness", title: "LearnHarness", version: appVersion },
			}, antigravityTimeouts.startupMs);
		} catch (error) {
			this.kill();
			throw error;
		}
		// Killed while the answer was in flight (e.g. a bad line in the same chunk).
		if (!this.alive) throw this.fatalError ?? new AcpTransportError("closed", AntigravityMessage.Exited);
		const handshake = parseHandshake(result);
		if (!handshake) {
			this.fail(new AcpTransportError("protocol", AntigravityMessage.UnsupportedProtocol));
			throw new AgentUnavailable(AntigravityMessage.UnsupportedProtocol);
		}
		this.handshake = handshake;
		if (this.holders === 0) this.armIdle();
	}

	request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
		return this.peer.request(method, params, timeoutMs);
	}

	/** A turn's setup request (session/new, set_config_option, …). No answer in time means the agent is wedged: kill it. */
	async setupRequest(method: string, params: unknown): Promise<unknown> {
		return (await this.setupRequestStamped(method, params)).result;
	}

	/**
	 * The ACP `authenticate` request with the personal Google method, sent ONLY for the user's Sign in
	 * click. The agent opens its own browser sign-in; LearnHarness never sees a link or token, and the
	 * answer (account details in _meta) is dropped unread. No answer in time: the connection is closed.
	 */
	async signIn(): Promise<void> {
		if (!this.handshake.googleSignIn) throw new AgentUnavailable(AntigravityMessage.SignInUnsupported);
		try {
			await this.peer.requestStamped("authenticate", { methodId: GOOGLE_SIGN_IN_METHOD }, antigravityTimeouts.signInMs, AntigravityMessage.SignInTimeout);
		} catch (error) {
			if (isAcpTransportError(error) && error.kind === "timeout") this.fail(error);
			throw error;
		}
	}

	/** setupRequest, also giving the frame number the answer arrived in (see `frame`). */
	async setupRequestStamped(method: string, params: unknown): Promise<Stamped> {
		try {
			return await this.peer.requestStamped(method, params, antigravityTimeouts.startupMs, AntigravityMessage.AnswerTimeout);
		} catch (error) {
			if (isAcpTransportError(error) && error.kind === "timeout") this.fail(error);
			throw error;
		}
	}

	/** The number of the incoming frame being handled now (or the last one). */
	get frame(): number { return this.peer.frame; }

	notify(method: string, params: unknown): void {
		this.peer.notify(method, params);
	}

	/**
	 * Route this session's updates and permission requests to `listener` until
	 * the returned stop. Anything that arrived for it before (the agent may
	 * write a tool_call right after its session/new answer) is replayed first.
	 */
	watch(sessionId: string, listener: SessionListener): () => void {
		if (!sessionId || this.listeners.has(sessionId)) throw new AcpTransportError("protocol", AntigravityMessage.ProtocolError);
		this.listeners.set(sessionId, listener);
		const early = this.early.get(sessionId);
		this.early.delete(sessionId);
		// Options and mode replay in the order they arrived, each with its own frame.
		const replay: { frame: number; update: Record<string, unknown> }[] = [];
		if (early?.configOptions) replay.push({ frame: early.configOptions.frame, update: { sessionUpdate: "config_option_update", configOptions: early.configOptions.value } });
		if (early?.modeId) replay.push({ frame: early.modeId.frame, update: { sessionUpdate: "current_mode_update", currentModeId: early.modeId.value } });
		if (early?.malformed) replay.push(early.malformed);
		for (const { frame, update } of replay.sort((a, b) => a.frame - b.frame)) this.dispatch(() => listener.onUpdate(update, frame));
		const breach = early?.breach;
		if (breach && this.listeners.get(sessionId) === listener) {
			const call = { title: breach.title, kind: breach.toolKind };
			this.dispatch(() => breach.kind === "tool" ? listener.onUpdate({ sessionUpdate: "tool_call", ...call }, this.peer.frame) : listener.onPermissionRequest({ sessionId, toolCall: call, options: [] }));
		}
		return () => { if (this.listeners.get(sessionId) === listener) this.listeners.delete(sessionId); };
	}

	/** A turn in flight: no idle kill until every hold is released. */
	hold(): () => void {
		this.holders++;
		clearTimeout(this.idleTimer);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.holders--;
			if (this.holders > 0) return;
			if (this.stopWhenIdle) this.kill();
			else this.armIdle();
		};
	}

	/** Stop now if no turn holds the process, otherwise as soon as the last one lets go (a streaming reply finishes). */
	stopWhenUnused(): void {
		if (this.holders === 0) this.kill();
		else this.stopWhenIdle = true;
	}

	/** The provider was turned back on before the last turn let go: keep the process. */
	cancelStop(): void {
		this.stopWhenIdle = false;
	}

	/** SIGTERM, then SIGKILL after the grace period. */
	kill(): void {
		if (this.exited || this.stopping) return;
		this.stopping = true;
		clearTimeout(this.idleTimer);
		this.signal("SIGTERM");
		this.killTimer = setTimeout(() => this.signal("SIGKILL"), antigravityTimeouts.killGraceMs);
		this.killTimer.unref();
	}

	/** Process exit: synchronous, no grace. Never throws: the exit hook must reach every connection. */
	killNow(): void {
		if (this.exited) return;
		this.signal("SIGKILL");
		try { rmSync(this.root, { recursive: true, force: true }); } catch { /* best effort at exit */ }
	}

	/** The connection broke the protocol (e.g. a malformed session/new answer): kill it, and return the error for the caller. */
	failProtocol(): AcpTransportError {
		const error = new AcpTransportError("protocol", AntigravityMessage.ProtocolError);
		this.fail(error);
		return this.fatalError ?? error;
	}

	private signal(name: NodeJS.Signals): void {
		try { this.child.kill(name); } catch { /* already gone; `exit`/`error` report it */ }
	}

	private armIdle(): void {
		clearTimeout(this.idleTimer);
		if (!this.alive) return;
		this.idleTimer = setTimeout(() => { if (this.holders === 0) this.kill(); }, antigravityTimeouts.idleMs);
		this.idleTimer.unref();
	}

	private fail(error: AcpTransportError): void {
		this.fatalError ??= error;
		this.peer.close(this.fatalError);
		this.kill();
	}

	/** Listener code never escapes the stdout handler. */
	private dispatch<T>(run: () => T): T | undefined {
		try { return run(); }
		catch {
			if (!this.listenerFailureLogged) { this.listenerFailureLogged = true; console.error("Antigravity: a session handler failed."); }
			return undefined;
		}
	}

	/** The early state for a session, making room by dropping the oldest session without a breach. */
	private earlyFor(sessionId: string): Early {
		let state = this.early.get(sessionId);
		if (!state) {
			if (this.early.size >= EARLY_MAX_SESSIONS) {
				const victim = [...this.early].find(([, value]) => !value.breach && !value.malformed)?.[0] ?? this.early.keys().next().value!;
				this.early.delete(victim);
			}
			state = {};
			this.early.set(sessionId, state);
		}
		return state;
	}

	private keepEarlyUpdate(sessionId: string, update: Record<string, unknown>): void {
		switch (update.sessionUpdate) {
			case "tool_call":
			case "tool_call_update": {
				const state = this.earlyFor(sessionId);
				state.breach ??= { kind: "tool", title: label(update.title), toolKind: label(update.kind) };
				return;
			}
			case "config_option_update":
				if (Array.isArray(update.configOptions)) this.earlyFor(sessionId).configOptions = { value: update.configOptions, frame: this.peer.frame };
				else this.earlyFor(sessionId).malformed ??= { update: { sessionUpdate: "config_option_update", configOptions: null }, frame: this.peer.frame };
				return;
			case "current_mode_update":
				if (typeof update.currentModeId === "string") this.earlyFor(sessionId).modeId = { value: update.currentModeId.slice(0, 200), frame: this.peer.frame };
				else this.earlyFor(sessionId).malformed ??= { update: { sessionUpdate: "current_mode_update", currentModeId: null }, frame: this.peer.frame };
				return;
			default:
				return; // chunks and everything else: nothing is kept
		}
	}

	private route(method: string, params: unknown): void {
		if (method !== "session/update" || !isRecord(params) || typeof params.sessionId !== "string" || !params.sessionId || !isRecord(params.update)) return;
		const update = params.update;
		const listener = this.listeners.get(params.sessionId);
		if (listener) this.dispatch(() => listener.onUpdate(update, this.peer.frame));
		else this.keepEarlyUpdate(params.sessionId, update);
	}

	private serve(method: string, params: unknown): unknown {
		if (method === "session/request_permission" && isRecord(params)) {
			const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
			const listener = this.listeners.get(sessionId);
			if (listener) return this.dispatch(() => listener.onPermissionRequest(params)) ?? CANCELLED;
			// Nobody watches it yet: refuse now, and let the turn see it when it watches.
			if (sessionId) {
				const call = isRecord(params.toolCall) ? params.toolCall : {};
				this.earlyFor(sessionId).breach ??= { kind: "permission", title: label(call.title), toolKind: label(call.kind) };
			}
			return rejectOnce(params);
		}
		throw methodNotFound(method);
	}

	/** stderr content is never kept or logged: only its size, and the sign-in signal. */
	private readStderr(chunk: Buffer): void {
		this.stderrBytes += chunk.length;
		const lines = (this.stderrPartial + chunk.toString("utf8")).split("\n");
		this.stderrPartial = (lines.pop() ?? "").slice(0, STDERR_PARTIAL_BYTES);
		if ([...lines, this.stderrPartial].some((line) => line.trimStart().startsWith(SIGN_IN_LINE_PREFIX))) {
			this.fail(new AcpTransportError("sign-in", AntigravityMessage.NotSignedIn));
		}
	}

	private handleExit(): void {
		if (this.exited) return;
		this.exited = true;
		const { code, signal } = this.exitInfo;
		clearTimeout(this.idleTimer);
		clearTimeout(this.killTimer);
		clearTimeout(this.drainTimer);
		exitState().live.delete(this);
		for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) stream.destroy();
		const error = this.fatalError ?? new AcpTransportError("closed", AntigravityMessage.Exited);
		this.peer.close(error);
		// An exit LearnHarness asked for (idle, shutdown, a kill after cancel or a fatal signal) logs nothing.
		if (!this.stopping) {
			console.error(`Antigravity exited unexpectedly (exit code ${code ?? "none"}, signal ${signal ?? "none"}); ${this.stderrBytes} bytes of error output not shown.`);
		}
		for (const listener of [...this.listeners.values()]) this.dispatch(() => listener.onClosed(error));
		this.listeners.clear();
		this.early.clear();
		rm(this.root, { recursive: true, force: true }).catch(() => { /* swept on the next start */ });
		this.resolveClosed(error);
	}
}

export interface RuntimeOptions {
	launch?: LaunchAgent;
	/** Parent of the per-process temp roots. */
	tempBase?: string;
	appVersion?: string;
	/** The server's environment; externalCliEnv() is always applied to it. */
	env?: () => NodeJS.ProcessEnv;
}

export class AntigravityRuntime {
	private current: { connection: AgentConnection; ready: Promise<AgentConnection> } | undefined;
	private readonly launch: LaunchAgent;
	readonly tempBase: string;
	private readonly appVersion: string;
	private readonly env: () => NodeJS.ProcessEnv;

	constructor(options: RuntimeOptions = {}) {
		this.launch = options.launch ?? createAgentLauncher();
		this.tempBase = options.tempBase ?? join(tmpdir(), TEMP_FOLDER);
		this.appVersion = options.appVersion ?? packageMetadata.version;
		this.env = options.env ?? (() => process.env);
	}

	/** The shared, handshaken process. Concurrent first callers share one start. */
	connect(): Promise<AgentConnection> {
		if (this.current?.connection.alive) return this.current.ready;
		let connection: AgentConnection;
		try { connection = this.spawn(); }
		catch (error) { return Promise.reject(error); }
		const ready = connection.initialize(this.appVersion).then(() => connection);
		const entry = { connection, ready };
		this.current = entry;
		void connection.closed.then(() => { if (this.current === entry) this.current = undefined; });
		return ready;
	}

	/** The live process, if any, without starting one. */
	get connection(): AgentConnection | undefined {
		return this.current?.connection.alive ? this.current.connection : undefined;
	}

	shutdown(): void {
		this.current?.connection.kill();
	}

	/** The provider was turned off: stop the agent without cutting off a reply in flight. */
	stopWhenUnused(): void {
		this.current?.connection.stopWhenUnused();
	}

	/** The provider was turned back on: forget a stop that was waiting for the last turn. */
	cancelStop(): void {
		this.current?.connection.cancelStop();
	}

	/**
	 * The shared process, held for the caller from the moment it asks (also while a cold start is still
	 * running `initialize`), so turning the provider off meanwhile waits for this caller. `release`
	 * must be called on every path; it is already called when this rejects.
	 */
	async acquire(): Promise<{ connection: AgentConnection; release: () => void }> {
		const ready = this.connect();
		const starting = this.current?.connection;
		const early = starting?.hold();
		let connection: AgentConnection;
		try { connection = await ready; }
		catch (error) { early?.(); throw error; }
		if (connection === starting && early) return { connection, release: early };
		early?.();
		return { connection, release: connection.hold() };
	}

	private spawn(): AgentConnection {
		mkdirSync(this.tempBase, { recursive: true, mode: 0o700 });
		sweepLeftovers(this.tempBase);
		const root = mkdtempSync(join(this.tempBase, `${RUN_PREFIX}${process.pid}-`));
		const workspace = join(root, "workspace");
		const tempDir = join(root, "tmp");
		let child: ChildProcessWithoutNullStreams | null;
		try {
			mkdirSync(workspace);
			mkdirSync(tempDir);
			child = this.launch(["acp", "--sandbox"], { cwd: workspace, env: agentEnv(externalCliEnv(this.env()), tempDir) });
		} catch (error) {
			rmSync(root, { recursive: true, force: true });
			throw error;
		}
		if (!child) {
			rmSync(root, { recursive: true, force: true });
			throw new AgentUnavailable(AntigravityMessage.NotInstalled);
		}
		return new AgentConnection(child, root);
	}
}

const RUNTIME_KEY = Symbol.for("lh.antigravity.runtime");

/** The process-wide runtime; survives module re-evaluation. */
export function antigravityRuntime(): AntigravityRuntime {
	const g = globalThis as Record<symbol, AntigravityRuntime | undefined>;
	g[RUNTIME_KEY] ??= new AntigravityRuntime();
	return g[RUNTIME_KEY];
}
