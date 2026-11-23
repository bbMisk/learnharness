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
import { AcpPeer, AcpRpcError, AcpTransportError, methodNotFound, SIGN_IN_LINE_PREFIX, stripUrls } from "./acp-client.ts";
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

const STDERR_TAIL_BYTES = 4_096;
const TEMP_FOLDER = "learnharness-antigravity";
const RUN_PREFIX = "run-";
const STRIPPED_KEYS = new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);

export class AgentUnavailable extends Error {}

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
	if (error instanceof AcpRpcError) {
		if (error.code === -32000 || (error.code === -32603 && error.message.startsWith("No browser is available here"))) return AntigravityMessage.NotSignedIn;
		if (error.message.includes("SUBSCRIPTION_REQUIRED")) return AntigravityMessage.NoSubscription;
		const detail = stripUrls(error.message).trim().slice(0, 300);
		return detail ? `Antigravity reported an error: ${detail}` : "Antigravity reported an error.";
	}
	if (error instanceof AcpTransportError || error instanceof AgentUnavailable) return error.message;
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
	private holders = 0;
	private idleTimer: NodeJS.Timeout | undefined;
	private killTimer: NodeJS.Timeout | undefined;
	private fatalError: AcpTransportError | undefined;
	private stderrTail = "";
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
		child.stderr.on("data", (chunk: Buffer) => this.readStderr(chunk.toString("utf8")));
		child.stdin.on("error", () => { /* the exit handler reports the failure */ });
		child.once("error", () => this.fail(new AcpTransportError("closed", AntigravityMessage.Exited)));
		child.once("close", () => this.handleExit());
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

	notify(method: string, params: unknown): void {
		this.peer.notify(method, params);
	}

	/** Route this session's updates and permission requests to `listener` until the returned stop. */
	watch(sessionId: string, listener: SessionListener): () => void {
		this.listeners.set(sessionId, listener);
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

	private route(method: string, params: unknown): void {
		if (method !== "session/update" || !isRecord(params) || typeof params.sessionId !== "string" || !isRecord(params.update)) return;
		this.listeners.get(params.sessionId)?.onUpdate(params.update);
	}

	private serve(method: string, params: unknown): unknown {
		if (method === "session/request_permission" && isRecord(params)) {
			const listener = typeof params.sessionId === "string" ? this.listeners.get(params.sessionId) : undefined;
			return listener ? listener.onPermissionRequest(params) : { outcome: { outcome: "cancelled" } };
		}
		throw methodNotFound(method);
	}

	private readStderr(text: string): void {
		this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_BYTES);
		const lines = (this.stderrPartial + text).split("\n");
		this.stderrPartial = (lines.pop() ?? "").slice(-STDERR_TAIL_BYTES);
		if ([...lines, this.stderrPartial].some((line) => line.replace(/^\s+/, "").startsWith(SIGN_IN_LINE_PREFIX))) {
			this.fail(new AcpTransportError("sign-in", AntigravityMessage.NotSignedIn));
		}
	}

	private handleExit(): void {
		if (this.exited) return;
		this.exited = true;
		clearTimeout(this.idleTimer);
		clearTimeout(this.killTimer);
		exitState().live.delete(this);
		const error = this.fatalError ?? new AcpTransportError("closed", AntigravityMessage.Exited);
		this.peer.close(error);
		const tail = stripUrls(this.stderrTail).trim();
		if (tail && error.kind !== "sign-in") console.error("Antigravity stderr (last 4 KB):", tail);
		for (const listener of [...this.listeners.values()]) listener.onClosed(error);
		this.listeners.clear();
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
