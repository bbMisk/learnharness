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
import { AcpPeer, AcpTransportError, isAcpRpcError, isAcpTransportError, methodNotFound, SIGN_IN_LINE_PREFIX, stripUrls } from "./acp-client.ts";
import { createAgentLauncher, type LaunchAgent } from "./binary.ts";
import { AntigravityMessage } from "./constants.ts";

/** Test seams (claude-code/live-processes.ts's liveProcessIdleTimeoutMs idiom). */
export const antigravityTimeouts = {
	/** initialize, and every setup request of a turn (session/new, set_config_option, …). */
	startupMs: 90_000,
	/** No turn in flight for this long: the process is stopped. */
	idleMs: 10 * 60_000,
	/** An open prompt with no update for this long is cancelled. */
	inactivityMs: 15 * 60_000,
	/** After session/cancel, how long the prompt may take to resolve before the process is killed. */
	cancelGraceMs: 5_000,
	/** SIGTERM, then SIGKILL after this. */
	killGraceMs: 1_000,
};

const STDERR_PARTIAL_BYTES = 4_096;
/** Updates for a session nobody watches yet are kept this long, this many, for this many sessions. */
const EARLY_TTL_MS = 10_000;
const EARLY_MAX_ENTRIES = 200;
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

/** -32000, or the 1.5 agent's "No browser is available here" -32603, on any request. */
export function isSignInError(error: unknown): boolean {
	return isAcpRpcError(error) && (error.code === -32000 || (error.code === -32603 && error.message.startsWith("No browser is available here")));
}

export interface AgentHandshake {
	/** "1.5.12", from agentInfo.version. */
	agentVersion: string | null;
	/** initialize advertised agentCapabilities._meta.antigravity.systemPrompt.append. */
	systemPromptAppend: boolean;
	/** initialize advertised sessionCapabilities.close. */
	sessionClose: boolean;
}

export interface SessionListener {
	onUpdate(update: Record<string, unknown>): void;
	/** The answer to session/request_permission for this session. */
	onPermissionRequest(params: Record<string, unknown>): unknown;
	/** The process is gone; `error.message` is one of ours. */
	onClosed(error: AcpTransportError): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Early = { at: number; kind: "update"; update: Record<string, unknown> } | { at: number; kind: "permission"; params: Record<string, unknown> };

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
	return { agentVersion: version, systemPromptAppend: meta?.append === true, sessionClose: close === true || isRecord(close) };
}

/** One plain sentence for any failure; never raw agent output, never a link. */
export function describeAgentError(error: unknown): string {
	if (isAcpRpcError(error)) {
		if (isSignInError(error)) return AntigravityMessage.NotSignedIn;
		if (error.message.includes("SUBSCRIPTION_REQUIRED")) return AntigravityMessage.NoSubscription;
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
	handshake: AgentHandshake = { agentVersion: null, systemPromptAppend: false, sessionClose: false };
	readonly workspace: string;
	readonly closed: Promise<AcpTransportError>;
	private readonly peer: AcpPeer;
	private readonly listeners = new Map<string, SessionListener>();
	private readonly early = new Map<string, Early[]>();
	private listenerFailureLogged = false;
	private holders = 0;
	private idleTimer: NodeJS.Timeout | undefined;
	private killTimer: NodeJS.Timeout | undefined;
	private fatalError: AcpTransportError | undefined;
	private stderrBytes = 0;
	private stderrPartial = "";
	private exited = false;
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
		child.stdout.on("end", () => this.peer.end());
		child.stderr.on("data", (chunk: Buffer) => this.readStderr(chunk));
		for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => { /* the exit handler reports the failure */ });
		// A spawn failure may emit only `error`; a running child that fails to be signalled emits it too.
		child.once("error", () => {
			if (child.pid === undefined) this.handleExit(null, null);
			else this.fail(new AcpTransportError("closed", AntigravityMessage.Exited));
		});
		// `exit` ends it: a helper that inherited the pipes can hold `close` back forever.
		child.once("exit", (code, signal) => this.handleExit(code, signal));
		child.once("close", (code, signal) => this.handleExit(code, signal));
		exitState().live.add(this);
	}

	get alive(): boolean { return !this.exited && !this.stopping; }

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
		try {
			return await this.peer.request(method, params, antigravityTimeouts.startupMs, AntigravityMessage.AnswerTimeout);
		} catch (error) {
			if (isAcpTransportError(error) && error.kind === "timeout") this.fail(error);
			throw error;
		}
	}

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
		this.pruneEarly();
		const early = this.early.get(sessionId) ?? [];
		this.early.delete(sessionId);
		for (const entry of early) {
			if (this.listeners.get(sessionId) !== listener) break;
			this.dispatch(() => entry.kind === "update" ? listener.onUpdate(entry.update) : listener.onPermissionRequest(entry.params));
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
			if (this.holders === 0) this.armIdle();
		};
	}

	/** SIGTERM, then SIGKILL after the grace period. */
	kill(): void {
		if (this.exited || this.stopping) return;
		this.stopping = true;
		clearTimeout(this.idleTimer);
		this.child.kill("SIGTERM");
		this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), antigravityTimeouts.killGraceMs);
		this.killTimer.unref();
	}

	/** Process exit: synchronous, no grace. */
	killNow(): void {
		if (this.exited) return;
		this.child.kill("SIGKILL");
		try { rmSync(this.root, { recursive: true, force: true }); } catch { /* best effort at exit */ }
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

	private pruneEarly(): void {
		const cutoff = Date.now() - EARLY_TTL_MS;
		for (const [sessionId, entries] of this.early) {
			while (entries[0] && entries[0].at < cutoff) entries.shift();
			if (entries.length === 0) this.early.delete(sessionId);
		}
	}

	private keepEarly(sessionId: string, entry: Early): void {
		if (!sessionId) return;
		this.pruneEarly();
		let entries = this.early.get(sessionId);
		if (!entries) {
			if (this.early.size >= EARLY_MAX_SESSIONS) this.early.delete(this.early.keys().next().value!);
			entries = [];
			this.early.set(sessionId, entries);
		}
		if (entries.length >= EARLY_MAX_ENTRIES) entries.shift();
		entries.push(entry);
	}

	private route(method: string, params: unknown): void {
		if (method !== "session/update" || !isRecord(params) || typeof params.sessionId !== "string" || !isRecord(params.update)) return;
		const update = params.update;
		const listener = this.listeners.get(params.sessionId);
		if (listener) this.dispatch(() => listener.onUpdate(update));
		else this.keepEarly(params.sessionId, { at: Date.now(), kind: "update", update });
	}

	private serve(method: string, params: unknown): unknown {
		if (method === "session/request_permission" && isRecord(params)) {
			const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
			const listener = this.listeners.get(sessionId);
			if (listener) return this.dispatch(() => listener.onPermissionRequest(params)) ?? CANCELLED;
			// Nobody watches it yet: refuse now, and let the turn see it when it watches.
			this.keepEarly(sessionId, { at: Date.now(), kind: "permission", params });
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

	private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exited) return;
		this.exited = true;
		clearTimeout(this.idleTimer);
		clearTimeout(this.killTimer);
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
